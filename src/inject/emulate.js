/**
 * Runs in the framed page's MAIN world.
 *
 * `emulateInFrame` is handed to chrome.scripting.executeScript as `func`, which
 * serialises it and re-parses it inside the page. It therefore MUST be entirely
 * self-contained: no imports, no closure over module scope, no references to
 * anything outside its own body.
 *
 * Headers convince the server; this convinces the page:
 *   - navigator.* so client-side device detection agrees with the UA header
 *   - synthesized touch events so swipe-driven UI responds to a mouse drag
 *   - scroll reporting so the viewer can keep side-by-side devices in step
 *
 * It also reports things only code inside the page can see: the `@media`
 * condition texts of its own stylesheets, its scroll metrics, and any errors it
 * throws. Condition texts are sent raw and parsed by src/lib/breakpoints.js -
 * this file cannot import a parser, and duplicating one here would put it
 * beyond the reach of tests.
 */

export function emulateInFrame({ devices, syncScroll }) {
  // Injection happens on every navigation; make it idempotent.
  if (window.__gonbiEmulated) return;
  window.__gonbiEmulated = true;

  /*
   * Which pane is this?
   *
   * declarativeNetRequest rules are tab-scoped, so the *header* UA is shared
   * across a comparison - but the spoofed navigator need not be. The viewer
   * names each iframe "gonbi-pane-N", and window.name is readable here
   * synchronously, which avoids any frame-id mapping and any round trip that
   * page scripts could run inside. A site that overwrites window.name just
   * falls back to the leading device.
   */
  const paneIndex = Number(/^gonbi-pane-(\d+)$/.exec(window.name)?.[1] ?? 0);
  const { ua, platform, touch, dpr } = devices[paneIndex] ?? devices[0];

  const def = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch {
      /* some properties are locked down; best effort */
    }
  };

  // ------------------------------------------------------------- navigator --
  const mobile = platform === 'iOS' || platform === 'Android';

  def(navigator, 'userAgent', ua);
  def(navigator, 'appVersion', ua.replace(/^Mozilla\//, ''));
  def(
    navigator,
    'vendor',
    /iPhone|iPad|Macintosh|Safari/.test(ua) && !/Chrome|CriOS|Firefox/.test(ua)
      ? 'Apple Computer, Inc.'
      : /Firefox|FxiOS/.test(ua)
        ? ''
        : 'Google Inc.',
  );
  def(
    navigator,
    'platform',
    platform === 'iOS'
      ? /iPad/.test(ua)
        ? 'iPad'
        : 'iPhone'
      : platform === 'Android'
        ? 'Linux armv8l'
        : platform === 'macOS'
          ? 'MacIntel'
          : 'Win32',
  );
  def(navigator, 'maxTouchPoints', touch ? 5 : 0);
  def(window, 'devicePixelRatio', dpr);

  if (navigator.userAgentData) {
    const brands = navigator.userAgentData.brands;
    def(navigator, 'userAgentData', {
      brands,
      mobile,
      platform,
      getHighEntropyValues: (hints) =>
        Promise.resolve({
          brands,
          mobile,
          platform,
          ...Object.fromEntries(hints.map((h) => [h, ''])),
        }),
      toJSON: () => ({ brands, mobile, platform }),
    });
  }

  if (touch) {
    if (!('ontouchstart' in window)) {
      try {
        window.ontouchstart = null;
      } catch {
        /* ignore */
      }
    }
  } else {
    def(window, 'ontouchstart', undefined);
  }

  // ---------------------------------------------------------------- touch ---
  /**
   * Turn a mouse drag into a touch sequence. Real touch devices also emit
   * compatibility mouse events, so the originals are left alone and these are
   * dispatched alongside - which is what a phone actually does.
   */
  if (touch && typeof window.TouchEvent === 'function') {
    let dragging = false;

    const touchFrom = (event, target) =>
      new Touch({
        identifier: 1,
        target,
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        screenX: event.screenX,
        screenY: event.screenY,
        radiusX: 11,
        radiusY: 11,
        rotationAngle: 0,
        force: 1,
      });

    const dispatch = (type, event, active) => {
      const target = event.target instanceof Element ? event.target : document.body;
      if (!target) return;
      let point;
      try {
        point = touchFrom(event, target);
      } catch {
        return;
      }
      const list = active ? [point] : [];
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          touches: list,
          targetTouches: list,
          changedTouches: [point],
        }),
      );
    };

    window.addEventListener(
      'mousedown',
      (event) => {
        if (event.button !== 0 || !event.isTrusted) return;
        dragging = true;
        dispatch('touchstart', event, true);
      },
      true,
    );
    window.addEventListener(
      'mousemove',
      (event) => {
        if (!dragging || !event.isTrusted) return;
        dispatch('touchmove', event, true);
      },
      true,
    );
    window.addEventListener(
      'mouseup',
      (event) => {
        if (!dragging || !event.isTrusted) return;
        dragging = false;
        dispatch('touchend', event, false);
      },
      true,
    );
  }

  // ------------------------------------------------------------ messaging ---
  const post = (message) => {
    try {
      window.parent.postMessage(message, '*');
    } catch {
      /* parent gone */
    }
  };

  /**
   * Scrolls we applied ourselves must not be reported back as if the reader had
   * made them, or two panes ping-pong. A rAF flag is not enough: `scrollTo` on a
   * page with `scroll-behavior: smooth` animates over many frames, and every
   * frame of that animation would look like a fresh scroll. A short deadline
   * covers the whole settle. It only ever gags a pane that was just driven from
   * elsewhere - the pane under the pointer is never sent a scrollTo, so its own
   * reporting is untouched.
   */
  const ECHO_MS = 150;
  let echoUntil = 0;

  const isDocScroller = (node) =>
    node === document || node === document.documentElement || node === document.body;

  /**
   * A selector for a scrollable element, so the other panes can find the same
   * node. Every pane shows the same page, so a structural path resolves - and
   * an id short-circuits it, which is what app shells usually give us.
   */
  const pathOf = (node) => {
    const parts = [];
    let cursor = node;
    while (cursor && cursor.nodeType === 1 && !isDocScroller(cursor)) {
      if (cursor.id) {
        parts.unshift(`#${CSS.escape(cursor.id)}`);
        return parts.join('>');
      }
      let part = cursor.tagName.toLowerCase();
      const parent = cursor.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(
          (c) => c.tagName === cursor.tagName,
        );
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cursor) + 1})`;
      }
      parts.unshift(part);
      cursor = cursor.parentElement;
    }
    return parts.length ? parts.join('>') : null;
  };

  // Command handlers are always installed: full-page capture drives the scroll
  // even when devices are not being compared.
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.__gonbi === 'scrollTo') {
      // A path means an inner scroller. If this pane cannot find it the page
      // differs here; scrolling the window instead would jump somewhere the
      // reader never asked for, so do nothing.
      const target = data.path ? document.querySelector(data.path) : window;
      if (!target) return;
      echoUntil = performance.now() + ECHO_MS;
      // 'instant' overrides the page's own `scroll-behavior: smooth`, which
      // would otherwise animate and leave the panes chasing each other.
      target.scrollTo({ left: data.x ?? 0, top: data.y ?? 0, behavior: 'instant' });
    } else if (data.__gonbi === 'measure') {
      const doc = document.documentElement;
      post({
        __gonbi: 'metrics',
        id: data.id,
        scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0),
        scrollWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0),
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        scrollY: window.scrollY,
      });
    } else if (data.__gonbi === 'audit') {
      post({ __gonbi: 'audit', id: data.id, ...runAudit(touch) });
    } else if (data.__gonbi === 'highlight') {
      const node = data.key
        ? document.querySelector(`[data-gonbi-audit="${data.key}"]`)
        : null;
      let ring = document.getElementById('__gonbi_ring');
      if (!node) {
        ring?.remove();
        return;
      }
      if (!ring) {
        ring = document.createElement('div');
        ring.id = '__gonbi_ring';
        ring.style.cssText =
          'position:absolute;z-index:2147483647;pointer-events:none;' +
          'border:2px solid #ff3b8d;background:rgba(255,59,141,.12);border-radius:2px';
        document.body?.append(ring);
      }
      const r = node.getBoundingClientRect();
      ring.style.left = `${r.left + window.scrollX}px`;
      ring.style.top = `${r.top + window.scrollY}px`;
      ring.style.width = `${r.width}px`;
      ring.style.height = `${r.height}px`;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (data.__gonbi === 'freeze') {
      /**
       * A sticky header would otherwise reappear in every slice of a stitched
       * full-page capture. Position has to be read from the computed style -
       * most fixed headers come from a stylesheet, not an inline style - and
       * pinned with an inline override that is removed again afterwards.
       */
      const style =
        document.getElementById('__gonbi_freeze') ?? document.createElement('style');
      style.id = '__gonbi_freeze';
      style.textContent = data.on
        ? '*{animation-play-state:paused!important;transition:none!important;scroll-behavior:auto!important}'
        : '';
      if (!style.parentNode) document.documentElement.append(style);

      if (data.on) {
        window.__gonbiPinned = [];
        for (const node of document.body?.querySelectorAll('*') ?? []) {
          const position = getComputedStyle(node).position;
          if (position !== 'fixed' && position !== 'sticky') continue;
          window.__gonbiPinned.push([node, node.style.position]);
          node.style.setProperty('position', 'absolute', 'important');
        }
      } else {
        for (const [node, previous] of window.__gonbiPinned ?? []) {
          node.style.position = previous;
        }
        window.__gonbiPinned = [];
      }
    }
  });

  if (syncScroll) {
    let latest = null;
    let scheduled = false;
    /*
     * Capture on the document, not a bubble listener on the window: scroll
     * events from an element do not bubble, so an app shell that scrolls an
     * inner `overflow:auto` container - rather than the page itself - would
     * never reach a window listener and would silently never sync.
     */
    document.addEventListener(
      'scroll',
      (event) => {
        if (performance.now() < echoUntil) return;
        const node = event.target;
        const inner = !isDocScroller(node);
        const path = inner ? pathOf(node) : null;
        // An unnameable inner scroller cannot be found in the other panes.
        if (inner && !path) return;
        // Keep only the newest position; one post per frame is plenty.
        latest = inner
          ? { x: node.scrollLeft, y: node.scrollTop, path }
          : { x: window.scrollX, y: window.scrollY, path: null };
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const send = latest;
          latest = null;
          if (send) post({ __gonbi: 'scroll', ...send });
        });
      },
      { passive: true, capture: true },
    );
  }

  // ------------------------------------------------------------ reporting ---
  /**
   * Media conditions from the page's own stylesheets. Cross-origin sheets throw
   * on .cssRules, so those are counted and reported rather than silently
   * dropped - a partial breakpoint list must not look complete.
   */
  const reportBreakpoints = () => {
    const conditions = [];
    let unreadable = 0;

    const walk = (rules) => {
      for (const rule of rules) {
        // CSSMediaRule, and the @supports / @layer blocks that can wrap it.
        if (rule.media?.mediaText) conditions.push(rule.media.mediaText);
        else if (rule.conditionText) conditions.push(rule.conditionText);
        if (rule.cssRules) {
          try {
            walk(rule.cssRules);
          } catch {
            unreadable++;
          }
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        unreadable++;
      }
    }
    post({ __gonbi: 'breakpoints', conditions, unreadable });
  };

  /**
   * The responsive and accessibility problems a screenshot will not show you.
   *
   * Runs entirely in the page, because only code in here can read layout and
   * computed styles. Findings are returned as generic groups so the viewer can
   * render whatever arrives without knowing the check names, and every reported
   * element is tagged so the viewer can ask for it to be highlighted.
   */
  function runAudit(isTouch) {
    const MIN_TAP = 24; // WCAG 2.5.8 AA
    const COMFY_TAP = 44; // Apple's human-interface guidance
    const MIN_TEXT = 12;
    const LIMIT = 12;

    let key = 0;
    const tag = (node) => {
      node.setAttribute('data-gonbi-audit', String(++key));
      return String(key);
    };

    const describe = (node) => {
      const name = node.tagName.toLowerCase();
      const id = node.id ? `#${node.id}` : '';
      const cls =
        typeof node.className === 'string' && node.className.trim()
          ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      const text = (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
      return `${name}${id}${cls}${text ? ` "${text}"` : ''}`;
    };

    const visible = (node, rect) => {
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(node);
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0'
      );
    };

    const docWidth = document.documentElement.clientWidth;
    const all = Array.from(document.body?.querySelectorAll('*') ?? []);
    const boxes = new Map();
    for (const node of all) boxes.set(node, node.getBoundingClientRect());

    const groups = [];
    const addGroup = (id, title, items, note) => {
      if (items.length) groups.push({ id, title, items, note });
    };

    // --- horizontal overflow ------------------------------------------------
    const spills = (rect) => rect.right > docWidth + 1 || rect.left < -1;
    const overflowing = new Set();
    for (const node of all) {
      const rect = boxes.get(node);
      if (visible(node, rect) && spills(rect)) overflowing.add(node);
    }
    /*
     * Only the outermost offenders are useful: if a wide element pushes past the
     * viewport, every descendant does too, and listing all of them buries the
     * one line you can act on.
     */
    const causes = [];
    for (const node of overflowing) {
      if (node.parentElement && overflowing.has(node.parentElement)) continue;
      const rect = boxes.get(node);
      if (causes.length >= LIMIT) break;
      causes.push({
        key: tag(node),
        label: describe(node),
        detail: `${Math.round(rect.width)}px wide, extends ${Math.round(
          rect.right - docWidth,
        )}px past the viewport`,
      });
    }
    addGroup('overflow', 'Horizontal overflow', causes);

    // --- zoom disabled ------------------------------------------------------
    /*
     * Blocking pinch-zoom fails WCAG 1.4.4 and is trivially easy to ship by
     * accident, since it is still copied around in boilerplate.
     */
    const viewportMeta = document.querySelector('meta[name="viewport"]');
    const content = viewportMeta?.getAttribute('content') ?? '';
    const zoomBlocks = [];
    if (/user-scalable\s*=\s*(no|0)/i.test(content)) {
      zoomBlocks.push({
        key: null,
        label: 'meta[name=viewport]',
        detail: 'user-scalable=no stops the reader zooming (WCAG 1.4.4)',
      });
    }
    const maxScale = /maximum-scale\s*=\s*([\d.]+)/i.exec(content);
    if (maxScale && Number(maxScale[1]) < 2) {
      zoomBlocks.push({
        key: null,
        label: 'meta[name=viewport]',
        detail: `maximum-scale=${maxScale[1]} caps zoom below 200% (WCAG 1.4.4)`,
      });
    }
    addGroup('zoom', 'Zoom restricted', zoomBlocks);

    // --- images without alt --------------------------------------------------
    /*
     * alt="" is a deliberate "this is decorative" and correct, so only a missing
     * attribute counts.
     */
    const noAlt = [];
    for (const node of Array.from(document.images ?? [])) {
      if (node.hasAttribute('alt')) continue;
      const rect = boxes.get(node) ?? node.getBoundingClientRect();
      if (!visible(node, rect)) continue;
      if (noAlt.length >= LIMIT) break;
      noAlt.push({
        key: tag(node),
        label: `img ${(node.currentSrc || node.src || '').split('/').pop().slice(0, 34)}`,
        detail: 'no alt attribute - add alt="" if it is decorative',
      });
    }
    addGroup('alt', 'Images without alt', noAlt);

    // --- unlabelled form fields ---------------------------------------------
    const labelled = (node) => {
      if (node.getAttribute('aria-label')?.trim()) return true;
      if (node.getAttribute('aria-labelledby')?.trim()) return true;
      if (node.getAttribute('title')?.trim()) return true;
      if (node.id && document.querySelector(`label[for="${CSS.escape(node.id)}"]`))
        return true;
      return !!node.closest('label');
    };
    const unlabelled = [];
    const FIELDS = 'input,select,textarea';
    for (const node of Array.from(document.body?.querySelectorAll(FIELDS) ?? [])) {
      if (/^(hidden|submit|button|reset|image)$/i.test(node.type ?? '')) continue;
      const rect = boxes.get(node) ?? node.getBoundingClientRect();
      if (!visible(node, rect)) continue;
      if (labelled(node)) continue;
      if (unlabelled.length >= LIMIT) break;
      unlabelled.push({
        key: tag(node),
        label: describe(node),
        detail: 'no label, aria-label or title - a screen reader announces nothing',
      });
    }
    addGroup('labels', 'Unlabelled form fields', unlabelled);

    // --- text contrast -------------------------------------------------------
    const parseColour = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value ?? '');
      if (!m) return null;
      const parts = m[1]
        .split(/[,/\s]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] : 1,
      };
    };
    const luminance = ({ r, g, b }) => {
      const chan = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
    };
    /** The first opaque background behind `node`, or null if it cannot be read. */
    const backdropOf = (node) => {
      for (let cur = node; cur; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        // An image or gradient behind the text makes the ratio unknowable.
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
        const colour = parseColour(style.backgroundColor);
        if (colour && colour.a > 0.9) return colour;
      }
      return { r: 255, g: 255, b: 255, a: 1 }; // the canvas default
    };

    const ownsText = (node) =>
      Array.from(node.childNodes).some(
        (child) => child.nodeType === 3 && child.textContent.trim().length > 1,
      );

    const lowContrast = [];
    const tiny = [];
    for (const node of all) {
      if (!ownsText(node)) continue;
      const rect = boxes.get(node);
      if (!visible(node, rect)) continue;

      const style = getComputedStyle(node);
      const size = parseFloat(style.fontSize);

      if (isTouch && size < MIN_TEXT && tiny.length < LIMIT) {
        tiny.push({
          key: tag(node),
          label: describe(node),
          detail: `${size.toFixed(1)}px, below the ${MIN_TEXT}px comfortable minimum`,
        });
      }

      const fg = parseColour(style.color);
      const bg = backdropOf(node);
      if (!fg || !bg || fg.a < 0.9) continue;
      const ratio =
        (Math.max(luminance(fg), luminance(bg)) + 0.05) /
        (Math.min(luminance(fg), luminance(bg)) + 0.05);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const required = large ? 3 : 4.5;
      if (ratio >= required || lowContrast.length >= LIMIT) continue;
      lowContrast.push({
        key: tag(node),
        label: describe(node),
        detail: `${ratio.toFixed(1)}:1 against its background, below the ${required}:1 needed at ${size.toFixed(0)}px`,
      });
    }
    addGroup(
      'contrast',
      'Low text contrast',
      lowContrast,
      'Text over an image or gradient is skipped, since the ratio cannot be read.',
    );

    // --- tap targets, touch devices only ------------------------------------
    let cramped = 0;
    if (isTouch) {
      const INTERACTIVE =
        'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
        '[role=button],[role=link],[role=checkbox],[role=tab],[tabindex]:not([tabindex="-1"])';
      const small = [];
      for (const node of Array.from(
        document.body?.querySelectorAll(INTERACTIVE) ?? [],
      )) {
        const rect = boxes.get(node) ?? node.getBoundingClientRect();
        if (!visible(node, rect)) continue;
        // WCAG exempts links flowing inside a sentence, which is most body copy.
        if (getComputedStyle(node).display === 'inline' && node.tagName === 'A')
          continue;
        if (rect.width < COMFY_TAP || rect.height < COMFY_TAP) cramped++;
        if (rect.width >= MIN_TAP && rect.height >= MIN_TAP) continue;
        if (small.length >= LIMIT) continue;
        small.push({
          key: tag(node),
          label: describe(node),
          detail: `${Math.round(rect.width)}x${Math.round(rect.height)}px, below the ${MIN_TAP}px minimum`,
        });
      }
      addGroup('taps', 'Small tap targets', small);
      addGroup('text', 'Small text', tiny);
    }

    return {
      viewportWidth: docWidth,
      total: groups.reduce((sum, g) => sum + g.items.length, 0),
      cramped,
      groups,
    };
  }

  const errors = [];
  const reportError = (message) => {
    if (!message || errors.includes(message)) return;
    errors.push(message);
    post({ __gonbi: 'pageError', message, count: errors.length });
  };

  window.addEventListener(
    'error',
    (event) => {
      if (event.target !== window && event.target?.tagName) {
        reportError(
          `Failed to load ${event.target.tagName.toLowerCase()}: ${
            event.target.src || event.target.href || '(unknown)'
          }`,
        );
        return;
      }
      reportError(event.message || String(event.error ?? 'Unknown error'));
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    reportError(
      `Unhandled rejection: ${event.reason?.message ?? String(event.reason)}`,
    );
  });

  if (document.readyState === 'complete') reportBreakpoints();
  else window.addEventListener('load', reportBreakpoints);

  /*
   * Audit findings describe the layout at one moment, so opening a menu or
   * loading a carousel silently invalidates them. Rather than re-auditing on
   * every mutation - which would be constant work on a busy page - this just
   * says "stale" and lets the viewer decide whether anyone is looking.
   */
  const watchForChanges = () => {
    if (!document.body) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        post({ __gonbi: 'stale' });
      }, 800);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  };
  if (document.body) watchForChanges();
  else window.addEventListener('DOMContentLoaded', watchForChanges);
}
