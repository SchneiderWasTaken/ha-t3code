// Injected ahead of T3 Code's web app. Home Assistant Ingress serves the app
// at /api/hassio_ingress/<token>/, but T3's client builds server URLs from the
// page origin ("/api/...", "/ws"). Rewrite those same-origin T3 URLs into the
// Ingress path at the browser APIs, so upstream code needs no changes.
(function () {
  "use strict";
  var base = String(window.__HA_INGRESS_PATH__ || "").replace(/\/+$/, "");
  if (!base) return;

  var PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp", "/attachments"];

  function isT3Path(p) {
    if (p === base || p.indexOf(base + "/") === 0) return false; // already inside Ingress
    for (var i = 0; i < PREFIXES.length; i++) {
      var pre = PREFIXES[i];
      if (p === pre || p.indexOf(pre + "/") === 0) return true;
    }
    return false;
  }

  // Returns the rewritten URL string, or null when it should be left alone.
  function rewrite(input) {
    if (input == null) return null;
    var url;
    try {
      url = new URL(String(input), location.href);
    } catch (e) {
      return null;
    }
    var sameHost = url.host === location.host;
    var web = url.protocol === "http:" || url.protocol === "https:";
    var socket = url.protocol === "ws:" || url.protocol === "wss:";
    if (!sameHost || !(web || socket) || !isT3Path(url.pathname)) return null;
    url.pathname = base + url.pathname;
    return url.href;
  }

  // fetch
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (input instanceof Request) {
      var r = rewrite(input.url);
      if (r) input = new Request(r, input);
    } else {
      var s = rewrite(input);
      if (s) input = s;
    }
    return origFetch.call(this, input, init);
  };

  // XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    var r = rewrite(url);
    if (r) args[1] = r;
    return origOpen.apply(this, args);
  };

  // WebSocket and EventSource
  function wrapConstructor(name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function (url, opts) {
      var r = rewrite(url);
      return opts === undefined ? new Orig(r || url) : new Orig(r || url, opts);
    };
    Wrapped.prototype = Orig.prototype;
    Object.getOwnPropertyNames(Orig).forEach(function (key) {
      if (!(key in Wrapped)) {
        try {
          Object.defineProperty(Wrapped, key, Object.getOwnPropertyDescriptor(Orig, key));
        } catch (e) {}
      }
    });
    window[name] = Wrapped;
  }
  wrapConstructor("WebSocket");
  wrapConstructor("EventSource");

  // navigator.sendBeacon, window.open
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return origBeacon(rewrite(url) || url, data);
    };
  }
  var origWindowOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    var r = rewrite(url);
    if (r) args[0] = r;
    return origWindowOpen.apply(this, args);
  };

  // Media and links built from server paths (attachments, image previews).
  var URL_ATTRS = { src: 1, href: 1, poster: 1, action: 1, formaction: 1 };
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (URL_ATTRS[String(name).toLowerCase()]) {
      var r = rewrite(value);
      if (r) value = r;
    }
    return origSetAttribute.call(this, name, value);
  };
  [
    [window.HTMLImageElement, "src"], [window.HTMLMediaElement, "src"], [window.HTMLSourceElement, "src"],
    [window.HTMLIFrameElement, "src"], [window.HTMLScriptElement, "src"], [window.HTMLAnchorElement, "href"],
    [window.HTMLLinkElement, "href"], [window.HTMLVideoElement, "poster"],
  ].forEach(function (pair) {
    var proto = pair[0] && pair[0].prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, pair[1]);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, pair[1], {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (value) {
        desc.set.call(this, rewrite(value) || value);
      },
    });
  });
})();
