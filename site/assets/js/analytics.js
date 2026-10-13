/*
 * PostHog analytics for mbsoft.github.io and its project pages. One copy of this file per repo
 * (mbsoft.github.io, waterboy/site); keep them identical.
 *
 * - Runs only on the live hosts (not localhost or previews) and honours Do Not Track.
 *   Add ?posthog=debug to a URL to run it anywhere, with PostHog's debug logging.
 * - Cookieless: persistence "memory" sets no cookies or localStorage, so there's no consent banner.
 *   Each page view is a new anonymous visitor (no returning-visitor tracking).
 * - Autocaptures pageviews and clicks; session replays mask every input and all text.
 * - Named events (for funnels): download_dmg, watch_demo, visit_site, view_code, featured_click.
 */
(function () {
  var KEY = "phc_qpUrD9JPQ6RPmLqi8YyV3Ueo5SDBr4nEtUUiRNadoTi2"; // public project key (phc_…), never a personal key (phx_…)
  var HOST = "https://us.i.posthog.com";        // EU cloud: https://eu.i.posthog.com
  var LIVE = /(^|\.)mbsoft\.(github\.io|com)$/;

  var debug = /[?&]posthog=debug\b/.test(location.search);
  if (!/^phc_/.test(KEY) || KEY.indexOf("REPLACE") !== -1) return;
  if (!debug && !LIVE.test(location.hostname)) return;
  if (!debug && (navigator.doNotTrack === "1" || window.doNotTrack === "1")) return;

  // PostHog's standard loader (the snippet from their docs): queues calls until array.js arrives.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags on onFeatureFlags onSessionId identify setPersonProperties group resetGroups reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(KEY, {
    api_host: HOST,
    persistence: "memory",
    person_profiles: "identified_only",
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    respect_dnt: !debug,
    disable_surveys: true,
    session_recording: { maskAllInputs: true, maskTextSelector: "*" },
    debug: debug,
  });

  function capture(event, props) {
    props = props || {};
    props.page = location.pathname;
    window.posthog.capture(event, props);
  }

  function label(el) {
    var img = el.querySelector && el.querySelector("img[alt]");
    var text = el.getAttribute("data-track-label") || el.getAttribute("aria-label") || (el.textContent || "").trim() || (img ? img.getAttribute("alt") : "");
    return text.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // Named click events, classified by where the link goes, so pages need no markup changes.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    var url;
    try { url = new URL(href, location.href); } catch (err) { return; }
    var props = { label: label(a), href: url.href };

    if (a.hasAttribute("data-download") || /\.dmg$/i.test(url.pathname)) {
      props.arch = a.getAttribute("data-download") || (/x64|intel/i.test(url.pathname) ? "x64" : "arm64");
      capture("download_dmg", props);
    } else if (/#demo$/.test(url.href) && url.pathname === location.pathname) {
      capture("watch_demo", { label: props.label, source: "link" });
    } else if (url.hostname === "github.com") {
      props.repo = url.pathname.split("/").slice(1, 3).join("/");
      capture("view_code", props);
    }

    var featured = a.closest(".featured");
    if (featured) {
      var title = featured.querySelector("h3");
      props.project = title ? title.textContent.split(":")[0].trim() : "";
      capture("featured_click", props);
    }
    if (/^visit the site$/i.test(props.label) || (a.closest(".card") && url.hostname === location.hostname && url.pathname !== location.pathname)) {
      capture("visit_site", props);
    }
  }, true);

  // A demo video starting to play (once per video per page view).
  document.addEventListener("play", function (e) {
    var v = e.target;
    if (!v || v.tagName !== "VIDEO" || v.__phPlayed) return;
    v.__phPlayed = true;
    var src = v.currentSrc || (v.querySelector("source") || {}).src || "";
    capture("watch_demo", { source: "video", video: src.split("/").pop() });
  }, true);
})();
