/**
 * The Issues panel: findings for every pane, a sweep across the page's declared
 * breakpoints, and a Markdown export.
 *
 * Kept apart from viewer.js because it grew its own state machine. It talks to
 * the rest of the viewer through a small context rather than reaching for module
 * globals, so the sweep can drive widths without this file knowing how sizing
 * works.
 */

/** A page can declare dozens of breakpoints; sweeping them all is too slow. */
const MAX_SWEEP_STEPS = 12;

/** Evenly sample `widths` down to at most `limit`, always keeping the ends. */
export function sampleWidths(widths, limit = MAX_SWEEP_STEPS) {
  if (widths.length <= limit) return [...widths];
  const step = (widths.length - 1) / (limit - 1);
  const picked = [];
  for (let i = 0; i < limit; i++) picked.push(widths[Math.round(i * step)]);
  return [...new Set(picked)];
}

/** Findings as Markdown, for pasting into a ticket. */
export function toMarkdown({ url, device, panes, sweep }) {
  const lines = [`# Responsive audit`, '', `- Page: ${url}`, `- Device: ${device}`];
  lines.push(
    `- Checked: ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
    '',
  );

  if (sweep?.length) {
    lines.push('## Across declared breakpoints', '');
    lines.push('| Width | Issues | Detail |', '| --- | --- | --- |');
    for (const row of sweep) {
      const detail = row.groups.length
        ? row.groups.map((g) => `${g.title} (${g.items.length})`).join(', ')
        : 'clean';
      lines.push(`| ${row.width}px | ${row.total} | ${detail} |`);
    }
    lines.push('');
  }

  for (const pane of panes ?? []) {
    lines.push(`## ${pane.label} - ${pane.result.viewportWidth}px`, '');
    if (!pane.result.groups.length) {
      lines.push('No issues found.', '');
      continue;
    }
    for (const group of pane.result.groups) {
      lines.push(`### ${group.title} (${group.items.length})`, '');
      for (const item of group.items)
        lines.push(`- \`${item.label}\` - ${item.detail}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * @param ctx  {
 *   panel, badge,               // elements
 *   panes(), primary(),         // current state
 *   request(pane, kind),        // RPC into a framed page
 *   highlight(key),             // outline an element in the leading pane
 *   breakpoints(),              // widths the page declares
 *   setWidth(px), currentWidth(), restoreWidth(),
 *   download(name, text), flash(message, warn),
 *   fileName(suffix),
 * }
 */
export function createAudit(ctx) {
  let results = []; // one per pane
  let sweep = null; // rows, when a sweep has been run
  let stale = false;
  let busy = false;
  let timer;

  const count = () => results.reduce((sum, r) => sum + (r.result?.total ?? 0), 0);

  /**
   * Automatic checks only happen while the panel is open.
   *
   * An audit reads a bounding rect for every element in the page, which is a
   * forced layout of the whole document from inside the framed site - and it
   * was landing about a second after every navigation, in the middle of that
   * site's own startup. Worth spending when someone is reading the findings,
   * not otherwise; opening the panel checks on the spot.
   */
  const schedule = (delay = 1200) => {
    clearTimeout(timer);
    if (ctx.panel.hidden) {
      render();
      return;
    }
    timer = setTimeout(run, delay);
  };

  async function run() {
    if (busy) return;
    const panes = ctx.panes();
    if (!panes.length) return;
    busy = true;
    try {
      const gathered = [];
      for (const pane of panes) {
        const result = await ctx.request(pane, 'audit');
        if (result) {
          gathered.push({
            label: `${pane.device.brand} ${pane.device.name}`,
            result,
          });
        }
      }
      if (gathered.length) {
        results = gathered;
        sweep = null;
        stale = false;
      }
    } finally {
      busy = false;
    }
    render();
  }

  /**
   * Audit at each width the page's own media queries care about.
   *
   * This is the payoff for extracting breakpoints and free sizing: it answers
   * "where does this page break" rather than "how does it look here".
   */
  async function runSweep() {
    const widths = sampleWidths(ctx.breakpoints());
    if (!widths.length) {
      ctx.flash('No breakpoints found to sweep', true);
      return;
    }
    if (busy) return;
    busy = true;
    const restore = ctx.currentWidth();
    const rows = [];
    try {
      for (const [index, width] of widths.entries()) {
        ctx.flash(`Sweeping ${index + 1}/${widths.length} at ${width}px…`);
        ctx.setWidth(width);
        // Let the reflow finish before asking what it looks like.
        await new Promise((r) => setTimeout(r, 550));
        const result = await ctx.request(ctx.panes()[0], 'audit');
        rows.push({
          width,
          total: result?.total ?? 0,
          groups: result?.groups ?? [],
        });
      }
      sweep = rows;
      const broken = rows.filter((r) => r.total > 0).length;
      ctx.flash(
        broken
          ? `${broken} of ${rows.length} widths have issues`
          : `All ${rows.length} widths look clean`,
      );
    } finally {
      ctx.setWidth(restore);
      busy = false;
      render();
    }
  }

  function markStale() {
    if (busy || !results.length) return;
    stale = true;
    // Only worth re-running if someone is looking at the panel.
    if (!ctx.panel.hidden) schedule(900);
    else render();
  }

  function exportReport() {
    const text = toMarkdown({
      url: ctx.url(),
      device: `${ctx.primary().brand} ${ctx.primary().name}`,
      panes: results,
      sweep,
    });
    ctx.download(`${ctx.fileName('audit')}.md`, text);
    navigator.clipboard?.writeText(text).catch(() => {});
    ctx.flash('Report saved and copied');
  }

  // ------------------------------------------------------------- rendering --

  const button = (label, onClick, primaryStyle = false) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = primaryStyle ? 'failure__action' : 'panel__btn';
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  };

  function render() {
    const total = count();
    const checked = results.length > 0;

    /*
     * With nothing checked yet the badge is the way in, so it offers the check
     * rather than hiding - it only disappears when there is no page to check.
     */
    ctx.badge.hidden = !checked && !ctx.url();
    ctx.badge.textContent = !checked
      ? 'Check page'
      : total
        ? `${total} issue${total === 1 ? '' : 's'}${stale ? ' (stale)' : ''}`
        : `No issues${stale ? ' (stale)' : ''}`;
    ctx.badge.title = checked
      ? 'Responsive issues (I)'
      : 'Check this page for responsive and accessibility issues (I)';
    ctx.badge.classList.toggle('is-clean', checked && total === 0);
    ctx.badge.classList.toggle('is-idle', !checked);

    if (ctx.panel.hidden) return;
    ctx.panel.replaceChildren();

    const heading = document.createElement('p');
    heading.className = 'panel__hint is-ok';
    heading.textContent = stale
      ? 'The page changed since this was checked.'
      : `Hover a row to highlight it in the page.`;
    ctx.panel.append(heading);

    if (sweep) {
      const table = document.createElement('table');
      table.className = 'audit__table';
      table.innerHTML =
        '<thead><tr><th>Width</th><th>Issues</th><th>What</th></tr></thead>';
      const body = document.createElement('tbody');
      for (const row of sweep) {
        const tr = document.createElement('tr');
        tr.className = row.total ? 'is-bad' : 'is-good';
        const what = row.groups.length
          ? row.groups.map((g) => `${g.title} (${g.items.length})`).join(', ')
          : 'clean';
        for (const value of [`${row.width}px`, String(row.total), what]) {
          const td = document.createElement('td');
          td.textContent = value;
          tr.append(td);
        }
        tr.addEventListener('click', () => ctx.setWidth(row.width));
        tr.title = `Click to set the width to ${row.width}px`;
        body.append(tr);
      }
      table.append(body);
      ctx.panel.append(table);
    }

    for (const { label, result } of results) {
      const pane = document.createElement('div');
      pane.className = 'audit__pane';

      if (results.length > 1 || !sweep) {
        const title = document.createElement('h2');
        title.textContent = `${label} - ${result.viewportWidth}px - ${
          result.total
            ? `${result.total} issue${result.total === 1 ? '' : 's'}`
            : 'clean'
        }`;
        pane.append(title);
      }

      if (result.cramped) {
        const note = document.createElement('p');
        note.className = 'audit__note';
        note.textContent =
          `${result.cramped} tap target${result.cramped === 1 ? '' : 's'} below the ` +
          '44px comfortable size (24px is the accessibility minimum).';
        pane.append(note);
      }

      for (const group of result.groups) {
        const section = document.createElement('div');
        section.className = 'audit__group';
        const label3 = document.createElement('h3');
        label3.textContent = `${group.title} (${group.items.length})`;
        section.append(label3);

        if (group.note) {
          const note = document.createElement('p');
          note.className = 'audit__note';
          note.textContent = group.note;
          section.append(note);
        }

        const list = document.createElement('ul');
        for (const item of group.items) {
          const row = document.createElement('li');
          if (item.key) row.dataset.key = item.key;
          const name = document.createElement('span');
          name.className = 'audit__label';
          name.textContent = item.label;
          const detail = document.createElement('span');
          detail.className = 'audit__detail';
          detail.textContent = item.detail;
          row.append(name, detail);
          list.append(row);
        }
        section.append(list);
        pane.append(section);
      }
      ctx.panel.append(pane);
    }

    const actions = document.createElement('div');
    actions.className = 'audit__actions';
    actions.append(
      button('Re-check', () => run(), true),
      button(`Sweep ${ctx.breakpoints().length} breakpoints`, () => runSweep()),
      button('Export report', () => exportReport()),
    );
    ctx.panel.append(actions);
  }

  // Hovering a finding outlines it inside the framed page.
  ctx.panel.addEventListener('pointerover', (event) => {
    const row = event.target.closest('li[data-key]');
    if (row) ctx.highlight(row.dataset.key);
  });
  ctx.panel.addEventListener('pointerleave', () => ctx.highlight(null));

  ctx.badge.addEventListener('click', () => {
    ctx.panel.hidden = !ctx.panel.hidden;
    ctx.badge.setAttribute('aria-expanded', String(!ctx.panel.hidden));
    if (!ctx.panel.hidden && !results.length) run();
    else render();
  });

  return {
    run,
    schedule,
    markStale,
    render,
    reset: () => {
      results = [];
      sweep = null;
      stale = false;
      render();
    },
  };
}
