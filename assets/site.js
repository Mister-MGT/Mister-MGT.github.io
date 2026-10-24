/* Shared page behaviour: scroll reveals, Cape Town clock, share, copy, toast. */
(function () {
  'use strict';
  window.__siteReady = true;

  var root = document.documentElement;

  /* ---------- Scroll reveal ---------- */
  var revealables = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    root.classList.add('reveal-all');
  }

  /* ---------- Local time in Cape Town ---------- */
  var clock = document.querySelector('[data-clock]');
  var clockTime = document.querySelector('[data-clock-time]');
  if (clock && clockTime) {
    try {
      var fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false
      });
      var tick = function () {
        var now = new Date();
        clockTime.textContent = fmt.format(now);
        clockTime.dateTime = now.toISOString();
      };
      tick();
      clock.hidden = false;
      setInterval(tick, 20000);
    } catch (err) { /* time zone data unavailable: leave the clock hidden */ }
  }

  var year = document.querySelector('[data-year]');
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Toast ---------- */
  var toast = document.querySelector('[data-toast]');
  var toastText = document.querySelector('[data-toast-text]');
  var toastTimer;
  function showToast(message, isError) {
    if (!toast) return;
    toastText.textContent = message;
    toast.classList.toggle('is-error', !!isError);
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('is-on'); }, 2600);
  }

  function buzz() {
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
  }

  /* ---------- Clipboard ---------- */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        if (!legacyCopy(text)) throw new Error('copy failed');
      });
    }
    return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var resetTimer;
    btn.addEventListener('click', function () {
      copyText(btn.getAttribute('data-copy')).then(function () {
        btn.classList.add('is-done');
        buzz();
        showToast(btn.getAttribute('data-copy-label') || 'Copied');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () { btn.classList.remove('is-done'); }, 1800);
      }, function () {
        showToast('Couldn’t copy. Press and hold to copy instead.', true);
      });
    });
  });

  /* ---------- Share ---------- */
  var share = document.querySelector('[data-share]');
  if (share) {
    var url = location.origin && location.origin !== 'null' ? location.origin + location.pathname : location.href;
    var data = {
      title: 'Michael Thomson',
      text: 'Michael Thomson, Mechanical Engineering, University of Cape Town',
      url: url
    };
    if (!navigator.share) {
      share.querySelector('span').textContent = 'Copy link';
      share.setAttribute('aria-label', 'Copy link to this page');
    }
    share.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share(data).catch(function () { /* dismissed */ });
      } else {
        copyText(url).then(function () { buzz(); showToast('Link copied'); },
                           function () { showToast('Couldn’t copy the link', true); });
      }
    });
  }
})();
