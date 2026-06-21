/* =========================================================================
   STAGE 3 CLIENT — GitHub auth + fork save/load + review inbox
   This script augments the Stage 1/2 editor (tei-editor.html). Include it
   AFTER the editor's own script with:  <script src="stage3.js"></script>

   It expects these globals from the editor:
     parseTEI(text)         — load a TEI string into the editor
     STATE.xmlDoc           — current parsed TEI
     diffTEI(docA, docB)    — Stage-2 diff engine
     toast(msg, err)        — toast notifications
   It talks to the Cloudflare Functions under /api/*.
   ========================================================================= */
(function () {
  'use strict';

  var SESSION = { loggedIn: false, login: null, name: null };
  var LOADED_SHA = null;        // sha of the TEI we loaded from the fork
  var PENDING_PHOTOS = [];      // [{name, dataUrl}] chosen for this edit session

  /* ---------- small DOM helpers ---------- */
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; }); // network/offline → empty (treated as not-logged-in)
  }

  /* Parse a raw GitHub comment body into { label, text }.
     Comments are posted as:  "@author [label] message\n\n— ግምገማ · review comment from @x"
     - strips the trailing "— ግምገማ …" footer
     - strips leading "@mention " tokens
     - pulls out a leading "[label]" as the thread key (which change/paragraph) */
  function parseComment(body) {
    var s = String(body || '');
    // drop the footer line(s)
    var fi = s.indexOf('\n\n— ግምገማ');
    if (fi > -1) s = s.slice(0, fi);
    s = s.replace(/\n*—\s*ግምገማ[\s\S]*$/, '').trim();
    // strip leading @mentions
    s = s.replace(/^(?:@[^\s]+\s+)+/, '');
    // pull out [label]
    var label = '';
    var m = s.match(/^\s*\[([^\]]+)\]\s*/);
    if (m) { label = m[1].trim(); s = s.slice(m[0].length); }
    return { label: label, text: s.trim() };
  }

  /* ---------- inject the auth bar into the top bar ---------- */
  function injectAuthUI() {
    var topbar = document.querySelector('.topbar');
    if (!topbar) return;
    var wrap = el('span', { class: 'gh-auth', id: 'ghAuth' });
    wrap.style.marginLeft = '.6rem';
    topbar.appendChild(wrap);
    renderAuth();
  }
  function renderAuth() {
    var w = document.getElementById('ghAuth');
    if (!w) return;
    /* When signed out, the header shows only the page title — every
       functional control (tabs, download, sub-title, auth bar) is hidden.
       The single sign-in button lives on the home screen. */
    var tabs = document.getElementById('tabs');
    var tools = document.getElementById('editTools');
    var sub = document.querySelector('.topbar .sub');
    if (SESSION.loggedIn) {
      if (tabs) tabs.classList.remove('hidden');
      if (tools) tools.classList.remove('hidden');
      if (sub) sub.classList.remove('hidden');
      w.innerHTML =
        '<button class="btn btn-primary" id="ghCommitBtn">💾 አስቀምጥ</button> ' +
        '<button class="btn btn-primary" id="ghSaveBtn">ለግምገማ ላክ · Submit for review</button> ' +
        '<span style="color:#cbb98a;font-size:.8rem;font-family:var(--sans-eth)">' +
        escapeHtml(SESSION.name || SESSION.login) + '</span> ' +
        '<button class="btn btn-ghost" id="ghLogoutBtn">ውጣ</button>';
      document.getElementById('ghCommitBtn').addEventListener('click', commitToBranch);
      document.getElementById('ghSaveBtn').addEventListener('click', submitForReview);
      document.getElementById('ghLogoutBtn').addEventListener('click', logout);
    } else {
      if (tabs) tabs.classList.add('hidden');
      if (tools) tools.classList.add('hidden');
      if (sub) sub.classList.add('hidden');
      w.innerHTML = '';
    }
    updateHomeScreen();
  }

  /* When signed out, the home page shows only the welcome text + a GitHub
     login button; the manual file-drop is hidden (after sign-in the document
     is imported automatically). */
  function updateHomeScreen() {
    var login = document.getElementById('ghHomeLogin');
    var drop = document.getElementById('drop');
    if (SESSION.loggedIn) {
      if (login) login.classList.add('hidden');
      if (drop) drop.classList.add('hidden');
    } else {
      if (login) login.classList.remove('hidden');
      if (drop) drop.classList.add('hidden');
      var btn = document.getElementById('ghHomeLoginBtn');
      if (btn && !btn._wired) {
        btn._wired = true;
        btn.addEventListener('click', function () { window.location.href = '/api/auth/login'; });
      }
    }
  }

  /* ---------- session ---------- */
  function checkSession() {
    return api('/api/auth/me').then(function (d) {
      SESSION.loggedIn = !!d.loggedIn;
      SESSION.login = d.login || null;
      SESSION.name = d.name || d.login || null;
      renderAuth();
      if (SESSION.loggedIn) {
        refreshInbox();
        // auto-open the document on sign-in (no manual "Load" button anymore)
        if (!STATE_HAS_DOC()) loadFromFork(true);
      }
    });
  }
  function STATE_HAS_DOC() { return !!(window.STATE && STATE.xmlDoc); }
  function logout() {
    api('/api/auth/logout', { method: 'POST' }).then(function () {
      SESSION.loggedIn = false; SESSION.login = null; SESSION.name = null;
      clearEditor();
      renderAuth();
    });
  }

  /* Clear the loaded document and return to the welcome/login home screen. */
  function clearEditor() {
    if (window.STATE) { STATE.xmlDoc = null; }
    LOADED_SHA = null;
    PENDING_PHOTOS = [];
    var doc = document.getElementById('doc');
    if (doc) doc.innerHTML = '';
    var editor = document.getElementById('editor');
    if (editor) editor.classList.add('hidden');
    var loadScreen = document.getElementById('loadScreen');
    if (loadScreen) loadScreen.classList.remove('hidden');
    ['downloadBtn'].forEach(function (id) {
      var b = document.getElementById(id); if (b) b.disabled = true;
    });
    var inbox = document.getElementById('ghInbox');
    if (inbox) inbox.innerHTML = '';
    // make sure the editor tab is the active view
    var editTab = document.getElementById('tabEdit');
    if (editTab) editTab.click();
  }

  /* ---------- load the TEI from the user's fork ---------- */
  function loadFromFork(silent) {
    if (!silent) toast('ከGitHub በመጫን ላይ… · loading');
    api('/api/repo/load').then(function (d) {
      if (d.error) {
        var why = d.message ? (' — ' + d.message) : '';
        toast('መጫን አልተሳካም · load failed' + why, true);
        console.warn('load failed:', d);
        if (!silent && d.message) { try { alert('Load failed:\n\n' + d.message); } catch (e) {} }
        return;
      }
      LOADED_SHA = d.sha;
      PENDING_PHOTOS = [];
      if (typeof parseTEI === 'function') parseTEI(d.content);
      toast('ከGitHub ተጫነ · loaded');
    });
  }

  /* ---------- submit edits: commit to branch + open PR (with reviewer choice) ---------- */
  function submitForReview() {
    if (!window.STATE || !STATE.xmlDoc) { toast('መጀመሪያ ሰነድ ይጫኑ', true); return; }
    // fetch collaborators, then show the reviewer-choice modal
    api('/api/repo/collaborators').then(function (d) {
      var collabs = (d && d.collaborators) || [];
      openReviewerModal(collabs);
    });
  }

  function openReviewerModal(collabs) {
    // Always show a username dropdown — even when there's only one reviewer.
    // Fall back to the default reviewer (@hizclick) if none are returned.
    var people = (collabs && collabs.length)
      ? collabs.slice()
      : [{ login: 'hizclick' }];

    var options = people.map(function (c) {
      var sel = (c.login === 'hizclick') ? ' selected' : '';
      return '<option value="' + escapeAttr(c.login) + '"' + sel + '>@' + escapeHtml(c.login) + '</option>';
    }).join('');

    var revField =
      '<div class="field"><label for="revSelect">ገምጋሚ · reviewer</label>' +
      '<select id="revSelect" class="rev-pick" style="font-family:var(--sans-eth);width:100%">' +
      options + '</select></div>';

    var body =
      '<p class="hint">ለውጥዎን የሚገመግመውን ሰው ይምረጡ · choose who should review your change</p>' +
      revField +
      '<div class="field"><label>አጭር መግለጫ · short note (optional)</label>' +
      '<textarea id="prNote" placeholder="ምን እንደቀየሩ በአጭሩ"></textarea></div>';

    if (typeof openModal === 'function') {
      openModal('ለግምገማ ላክ · Submit for review', body, [
        { label: 'ይቅር · cancel', onClick: closeModalSafe },
        { label: 'ላክ · submit', primary: true, onClick: doSubmit },
      ]);
    } else {
      doSubmit(); // fallback if editor modal isn't available
    }
  }
  function closeModalSafe() { if (typeof closeModal === 'function') closeModal(); }

  function doSubmit() {
    var sel = document.getElementById('revSelect');
    var picks = (sel && sel.value) ? [sel.value] : [];
    var note = (document.getElementById('prNote') || {}).value || '';
    closeModalSafe();

    if (typeof saveTextEdits === 'function') saveTextEdits();
    var xml = new XMLSerializer().serializeToString(STATE.xmlDoc);
    if (xml.indexOf('<?xml') !== 0) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

    toast('በመላክ ላይ… · submitting');
    api('/api/repo/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: xml,
        message: note ? ('Edit by ' + SESSION.login + ': ' + note) : ('Edit by ' + SESSION.login),
        summary: note,
        reviewers: picks,
        photos: PENDING_PHOTOS,
      }),
    }).then(function (d) {
      if (d.ok) { showSubmitResult(d); PENDING_PHOTOS = []; }
      else { toast('መላክ አልተሳካም · submit failed', true); console.warn(d); }
    });
  }
  function commitToBranch() {
    if (!window.STATE || !STATE.xmlDoc) { toast('መጀመሪያ ሰነድ ይጫኑ', true); return; }
    if (typeof saveTextEdits === 'function') saveTextEdits();
    var xml = new XMLSerializer().serializeToString(STATE.xmlDoc);
    if (xml.indexOf('<?xml') !== 0) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;

    var btn = document.getElementById('ghCommitBtn');
    if (btn) btn.disabled = true;
    toast('በማስቀመጥ ላይ… · saving');
    api('/api/repo/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: xml,
        message: 'Save by ' + SESSION.login,
        photos: PENDING_PHOTOS,
      }),
    }).then(function (d) {
      if (btn) btn.disabled = false;
      if (d && d.ok) {
        toast('በቅርንጫፍዎ ተቀምጧል · saved to your branch (' + d.branch + ')');
        PENDING_PHOTOS = [];
      } else {
        toast('ማስቀመጥ አልተሳካም · save failed', true);
        console.warn(d);
      }
    });
  }
  function showSubmitResult(d) {
    toast('ለግምገማ ተልኳል · sent for review (PR #' + d.prNumber + ')');
    refreshInbox(); // make the new request appear in the Review tab immediately
    // a small confirmation panel
    var box = document.getElementById('submitResult');
    if (!box) {
      box = el('div', { id: 'submitResult', class: 'intro' });
      var wrap = document.querySelector('.wrap'); if (wrap) wrap.insertBefore(box, wrap.firstChild);
    }
    box.innerHTML =
      '<h2>✅ ለግምገማ ተልኳል · Sent for review</h2>' +
      '<p class="am">ለውጥዎ ወደ ' + (d.reviewers || []).map(function (r) { return '@' + r; }).join(', ') +
      ' ለግምገማ ተልኳል። ሲጸድቅ ይካተታል።</p>' +
      '<p><a href="' + escapeAttr(d.prUrl) + '" target="_blank" rel="noopener">በGitHub ይመልከቱ · view on GitHub →</a></p>';
  }

  /* Build a plain-Amharic summary by diffing against the originally-loaded TEI. */
  function buildChangeSummary() {
    return 'የቤተሰብ አርታኢ በኩል የተደረገ ለውጥ።'; // PR body intro; full diff is visible in the review tab
  }

  /* ---------- REVIEW INBOX (many reviews per reviewer) ---------- */
  function refreshInbox() {
    api('/api/review/inbox').then(function (d) {
      if (d.error) return;
      renderInbox(d.reviews || [], d.isAdmin, d.feedback || []);
    });
  }
  function renderInbox(reviews, isAdmin, feedback) {
    feedback = feedback || [];
    var panel = document.getElementById('review');
    if (!panel) return;
    var box = document.getElementById('ghInbox');
    if (!box) {
      box = el('div', { id: 'ghInbox' });
      panel.insertBefore(box, panel.firstChild);
    }

    var html = '<div class="intro"><h2>እንዲገመግሙ የተላከሎት</h2></div>';

    /* ----- Section 1: PRs assigned to you for review ----- */
    html += '<details open class="inbox-sec"><summary class="inbox-sum">' +
      '⚖ እንዲገመግሙ ተመድበዋል · Assigned to you for review' +
      ' <span class="change-kind entk">' + reviews.length + '</span></summary>';
    if (!reviews.length) {
      html += '<p class="am" style="margin:.3rem 0 1rem">አሁን እንዲገመግሙ የተመደበ ምንም ለውጥ የለም።</p>';
    } else {
      html += '<div id="ghReviewList">';
      reviews.forEach(function (r) {
        // the submitter's note (first line of the PR body); hide the auto boilerplate
        var note = (r.summary || '').trim();
        var noteHtml = (note && note.indexOf('Submitted by @') !== 0)
          ? '<div class="para-full" style="margin:.35rem 0">' +
              '<b>📝 ማስታወሻ · note from @' + escapeHtml(r.author) + ':</b> ' + escapeHtml(note) +
            '</div>'
          : '';
        html +=
          '<div class="change" id="ghpr_' + r.number + '">' +
          '<div class="change-h">' +
          '<span class="change-n">PR #' + r.number + '</span>' +
          '<span class="change-kind entk">@' + escapeHtml(r.author) + '</span>' +
          '<span style="font-size:.8rem;color:var(--ink-soft)">' + escapeHtml(r.title) + '</span>' +
          '</div>' +
          noteHtml +
          '<div class="change-foot">' +
          '<button class="btn" data-act="open" data-n="' + r.number + '">ለውጦችን አሳይ · show changes</button>' +
          '<button class="btn approve-btn" data-act="approve" data-n="' + r.number + '">✓ አጽድቅ · approve</button>' +
          '<input class="cmt-input" data-cmt="' + r.number + '" placeholder="አስተያየት ለጸሐፊው · comment"/>' +
          '<button class="btn" data-act="comment" data-n="' + r.number + '">ላክ · send</button>' +
          '<a class="btn btn-ghost" href="' + escapeAttr(r.url) + '" target="_blank" rel="noopener">GitHub →</a>' +
          '</div>' +
          '<div class="gh-diff" id="ghdiff_' + r.number + '"></div>' +
          '</div>';
      });
      html += '</div>';
    }

    /* ----- Section 2: feedback you received on your own submissions ----- */
    var fbCount = feedback.reduce(function (n, f) { return n + (f.comments ? f.comments.length : 0); }, 0);
    html += '</details><details open class="inbox-sec"><summary class="inbox-sum">' +
      '💬 የደረሱዎት አስተያየቶች · Comments you received' +
      ' <span class="change-kind tagk">' + fbCount + '</span>' +
      '<span class="am" style="display:block;font-weight:400;font-size:.78rem;margin-top:.2rem">በላኩት ለውጥ ላይ የተሰጡ አስተያየቶች — እርማት ለማድረግ ይጫኑ።</span></summary>';
    if (!feedback.length) {
      html += '<p class="am" style="margin:.3rem 0">ምንም አስተያየት የለም።</p>';
    } else {
      html += '<div id="ghFeedbackList">';
      feedback.forEach(function (f) {
        html += '<div class="change">' +
          '<div class="change-h">' +
          '<span class="change-n">PR #' + f.number + '</span>' +
          '<span style="font-size:.8rem;color:var(--ink-soft)">' + escapeHtml(f.title) + '</span>' +
          '</div>';

        // group this PR's comments into threads keyed by the [label] prefix
        var threads = []; var byKey = {};
        f.comments.forEach(function (c) {
          var pc = parseComment(c.body);
          var key = pc.label || '__general__';
          if (!byKey[key]) { byKey[key] = { label: pc.label, items: [], senders: [] }; threads.push(byKey[key]); }
          byKey[key].items.push({ author: c.author, mine: c.mine, text: pc.text });
          if (!c.mine && c.author && byKey[key].senders.indexOf(c.author) === -1) byKey[key].senders.push(c.author);
        });

        threads.forEach(function (t, ti) {
          var tid = f.number + '_' + ti;
          var heading = t.label
            ? escapeHtml(t.label)
            : 'አጠቃላይ · general';
          var replyTo = t.senders.join(',');
          var replyLabel = t.senders.length
            ? 'ለ ' + t.senders.map(function (s) { return '@' + s; }).join(', ') + ' መልስ · reply'
            : 'መልስ · reply';
          html += '<div class="change" style="margin:.4rem 0;background:#fbf8f1">' +
            '<div class="change-h"><span class="change-kind tagk">' + heading + '</span></div>' +
            '<div class="change-body">';
          t.items.forEach(function (it) {
            var who = it.mine ? 'እርስዎ · you' : '@' + escapeHtml(it.author);
            html += '<div class="para-full" style="margin:.3rem 0">' +
              '<b>' + who + ' said:</b> ' + escapeHtml(it.text) +
              '</div>';
          });
          html += '</div>' +
            '<div class="change-foot">' +
            '<input class="cmt-input reply-input" data-n="' + f.number + '" data-tid="' + tid + '" ' +
              'data-to="' + escapeAttr(replyTo) + '" data-label="' + escapeAttr(t.label) + '" ' +
              'placeholder="' + escapeAttr(replyLabel) + '"/>' +
            '<button class="btn reply-send" data-n="' + f.number + '" data-tid="' + tid + '" ' +
              'data-to="' + escapeAttr(replyTo) + '" data-label="' + escapeAttr(t.label) + '">መልስ ላክ · reply</button>' +
            '<span class="cmt-saved" id="rps_' + tid + '"></span>' +
            '</div>' +
            '</div>';
        });

        html += '<div class="change-foot">' +
          '<button class="btn btn-primary" data-act="fix" data-n="' + f.number + '">አስተካክል · make changes</button>' +
          '<a class="btn btn-ghost" href="' + escapeAttr(f.url) + '" target="_blank" rel="noopener">GitHub →</a>' +
          '</div>' +
          '</div>';
      });
      html += '</div>';
    }
    html += '</details>';

    box.innerHTML = html;
    wireInbox(box);
  }
  function wireInbox(box) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var n = btn.getAttribute('data-n');        var act = btn.getAttribute('data-act');
        if (act === 'open') showPrDiff(n);
        else if (act === 'approve') approvePr(n, btn);
        else if (act === 'fix') {
          // jump back to the editor so the author can apply the feedback,
          // then resubmit (which updates the same PR).
          loadFromFork();
          var editTab = document.getElementById('tabEdit');
          if (editTab) editTab.click();
          toast('እርማት ለማድረግ ሰነዱ ተጫነ · loaded for editing');
        }
        else if (act === 'comment') {
          var inp = box.querySelector('.cmt-input[data-cmt="' + n + '"]');
          commentPr(n, inp.value.trim());
        }
      });
    });
    // reply-to-sender on feedback cards (one reply box per comment thread)
    Array.prototype.forEach.call(box.querySelectorAll('.reply-send'), function (btn) {
      btn.addEventListener('click', function () {
        var n = btn.getAttribute('data-n');
        var tid = btn.getAttribute('data-tid');
        var to = btn.getAttribute('data-to') || '';
        var label = btn.getAttribute('data-label') || '';
        var inp = box.querySelector('.reply-input[data-tid="' + tid + '"]');
        var text = (inp && inp.value || '').trim();
        if (!text) return;
        var mentions = to ? to.split(',').filter(Boolean).map(function (u) { return '@' + u; }).join(' ') : '';
        var saved = document.getElementById('rps_' + tid);
        // re-attach the thread [label] so the reply stays grouped with the change
        var msg = (label ? '[' + label + '] ' : '') + (mentions ? mentions + ' ' : '') + text;
        btn.disabled = true;
        commentPr(n, msg).then(function (ok) {
          btn.disabled = false;
          if (ok) {
            if (saved) saved.textContent = '✓ ተልኳል · sent';
            if (inp) inp.value = '';
            refreshInbox(); // pull the new reply into the thread
          }
        });
      });
    });
  }
  function showPrDiff(number) {
    var target = document.getElementById('ghdiff_' + number);
    target.innerHTML = '<div class="rev-empty">በመጫን ላይ…</div>';
    api('/api/review/files?number=' + number).then(function (d) {
      if (d.error) { target.innerHTML = '<div class="rev-empty">መጫን አልተሳካም</div>'; return; }
      var docA = new DOMParser().parseFromString(d.base, 'application/xml');
      var docB = new DOMParser().parseFromString(d.head, 'application/xml');
      var changes = (typeof diffTEI === 'function') ? diffTEI(docA, docB) : [];
      if (!changes.length) {
        // The structured diff (and its text fallback) found nothing. That can
        // still happen for a REAL change that only touches XML structure or
        // attributes (e.g. tagging an existing word, changing a key/ref/geo) —
        // those leave the visible text identical. Compare the raw XML so we
        // never falsely report "no changes". Only when the raw strings are
        // truly identical do we say there is nothing to review.
        var rawA = (d.base || ''), rawB = (d.head || '');
        var normA = rawA.replace(/\s+/g, ' ').trim();
        var normB = rawB.replace(/\s+/g, ' ').trim();
        if (normA === normB) {
          target.innerHTML = '<div class="rev-empty">ምንም ለውጥ የለም · this version is identical to the current main (it may already be merged)</div>';
          return;
        }
        // Raw XML differs but no visible-text change — surface a tag/markup diff.
        changes = [{
          kind: 'tag', cls: 'tagk', pnum: 0,
          label: 'የመሰየም/መዋቅር ለውጥ ተገኝቷል · markup/tag change detected',
          body: (typeof wordDiff === 'function')
            ? wordDiff(normA, normB)
            : '<div class="para-full"><span class="new">' + escapeHtml(normB.slice(0, 4000)) + '</span></div>'
        }];
      }
      var html = '';
      changes.forEach(function (ch, i) {
        var label = 'ለውጥ ' + (i + 1) + ' · ' + ch.label;
        var gotoBtn = (ch.pnum && ch.pnum > 0)
          ? '<button class="btn goto-para" data-pnum="' + ch.pnum + '">📍 ወደ አንቀጽ ' + ch.pnum + ' ሂድ · go to paragraph</button>'
          : '';
        html += '<div class="change" style="margin:.4rem 0">' +
          '<div class="change-h"><span class="change-n">ለውጥ ' + (i + 1) + '</span>' +
          '<span class="change-kind ' + ch.cls + '">' + escapeHtml(ch.label) + '</span></div>' +
          '<div class="change-body">' + ch.body + '</div>' +
          '<div class="change-foot">' +
            gotoBtn +
            '<input class="cmt-input para-cmt" data-n="' + number + '" data-i="' + i + '" ' +
              'data-label="' + escapeAttr(label) + '" placeholder="ለዚህ አንቀጽ አስተያየት · comment on this paragraph"/>' +
            '<button class="btn para-cmt-send" data-n="' + number + '" data-i="' + i + '">ላክ · send</button>' +
            '<span class="cmt-saved" id="pcs_' + number + '_' + i + '"></span>' +
          '</div></div>';
      });
      // a single approve for the whole request (GitHub merges the PR as a unit)
      html += '<div class="change-foot" style="margin-top:.5rem">' +
        '<button class="btn approve-btn" data-act="approve-diff" data-n="' + number + '">✓ ይህን ጥያቄ አጽድቅ · approve this request</button>' +
        '</div>';
      target.innerHTML = html;

      // wire "go to paragraph" buttons
      Array.prototype.forEach.call(target.querySelectorAll('.goto-para'), function (btn) {
        btn.addEventListener('click', function () {
          var pnum = Number(btn.getAttribute('data-pnum'));
          if (typeof gotoParagraph === 'function') gotoParagraph(pnum);
        });
      });

      // wire per-paragraph comment send
      Array.prototype.forEach.call(target.querySelectorAll('.para-cmt-send'), function (btn) {
        btn.addEventListener('click', function () {
          var n = btn.getAttribute('data-n');
          var i = btn.getAttribute('data-i');
          var inp = target.querySelector('.para-cmt[data-n="' + n + '"][data-i="' + i + '"]');
          var text = (inp && inp.value || '').trim();
          if (!text) return;
          var label = inp.getAttribute('data-label') || '';
          var saved = document.getElementById('pcs_' + n + '_' + i);
          btn.disabled = true;
          commentPr(n, '[' + label + '] ' + text).then(function (ok) {
            btn.disabled = false;
            if (ok) { if (saved) saved.textContent = '✓ ተልኳል · sent'; if (inp) inp.value = ''; }
          });
        });
      });
      // wire the whole-request approve
      var apBtn = target.querySelector('[data-act="approve-diff"]');
      if (apBtn) apBtn.addEventListener('click', function () { approvePr(number, apBtn); });
    });
  }
  function approvePr(number, btn) {
    btn.disabled = true; btn.textContent = '…';
    api('/api/review/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: Number(number) }),
    }).then(function (d) {
      if (d.ok && d.merged) {
        btn.textContent = '✓ ጸድቆ ተካቷል · merged';
        var card = document.getElementById('ghpr_' + number); if (card) card.classList.add('approved');
        toast('ጸድቆ ተካቷል · approved & merged');
      } else if (d.conflict) {
        btn.disabled = false; btn.textContent = '✓ አጽድቅ · approve';
        toast('ግጭት — ለአስተዳዳሪው ተልኳል · conflict, sent to admin', true);
      } else {
        btn.disabled = false; btn.textContent = '✓ አጽድቅ · approve';
        toast('ማጽደቅ አልተሳካም · approve failed', true);
      }
    });
  }
  function commentPr(number, comment) {
    if (!comment) return Promise.resolve(false);
    return api('/api/review/comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: Number(number), comment: comment }),
    }).then(function (d) {
      toast(d.ok ? 'አስተያየት ተልኳል · comment sent' : 'መላክ አልተሳካም', !d.ok);
      return !!d.ok;
    });
  }

  /* ---------- utils ---------- */
  function escapeHtml(s) { return (s || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function escapeAttr(s) { return (s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* expose a hook so the editor's photo flow can register a chosen image file
     to be committed with the next submit:
        window.Stage3.addPendingPhoto(name, dataUrl)
  */
  window.Stage3 = {
    addPendingPhoto: function (name, dataUrl) { PENDING_PHOTOS.push({ name: name, dataUrl: dataUrl }); },
    refreshInbox: refreshInbox,
    session: function () { return SESSION; },
  };

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    injectAuthUI();
    checkSession();
    // refresh the review queue whenever the user opens the Review tab
    var tabReview = document.getElementById('tabReview');
    if (tabReview) {
      tabReview.addEventListener('click', function () {
        if (SESSION.loggedIn) refreshInbox();
      });
    }
    // if we just came back from OAuth, clean the ?auth= param
    if (/[?&]auth=/.test(location.search)) {
      history.replaceState({}, '', location.pathname);
    }
  });
})();
