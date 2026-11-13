const assert = require('node:assert/strict');
const test = require('node:test');
const { findNextFocusable, getFocusableElements } = require('../js/spatial-navigation.js');

function focusable(name, { left, top, width = 40, height = 40 }, options = {}) {
  const rect = { left, top, width, height, right: left + width, bottom: top + height };
  const attributes = options.attributes || {};
  return {
    name,
    disabled: Boolean(options.disabled),
    hidden: Boolean(options.hidden),
    inert: Boolean(options.inert),
    tabIndex: options.tabIndex ?? 0,
    parentElement: options.parentElement || null,
    getAttribute: name => attributes[name] ?? null,
    getClientRects: () => options.noClientRect ? [] : [rect],
    getBoundingClientRect: () => rect
  };
}

test('spatial movement prefers an aligned target and never wraps', () => {
  const current = focusable('current', { left: 0, top: 0, width: 100, height: 100 });
  const diagonal = focusable('diagonal', { left: 110, top: 115 });
  const aligned = focusable('aligned', { left: 150, top: 20 });

  assert.equal(findNextFocusable(current, 'right', [diagonal, aligned]), aligned);
  assert.equal(findNextFocusable(current, 'left', [diagonal, aligned]), null);
});

test('spatial movement ranks unaligned candidates by direction then cross-axis distance', () => {
  const current = focusable('current', { left: 0, top: 0 });
  const near = focusable('near', { left: 60, top: 60 });
  const far = focusable('far', { left: 180, top: 180 });

  assert.equal(findNextFocusable(current, 'down', [far, near]), near);
  assert.equal(findNextFocusable(current, 'right', [far, near]), near);
  assert.equal(findNextFocusable(current, 'up', [near, far]), null);
});

test('candidate collection excludes disabled, hidden, aria-hidden, inert and zero-size controls', () => {
  const hiddenParent = { hidden: false, inert: false, parentElement: null, getAttribute: name => name === 'aria-hidden' ? 'true' : null };
  const candidates = [
    focusable('visible', { left: 0, top: 0 }),
    focusable('disabled', { left: 0, top: 0 }, { disabled: true }),
    focusable('hidden', { left: 0, top: 0 }, { hidden: true }),
    focusable('aria-hidden', { left: 0, top: 0 }, { parentElement: hiddenParent }),
    focusable('inert', { left: 0, top: 0 }, { inert: true }),
    focusable('zero-client-rects', { left: 0, top: 0 }, { noClientRect: true }),
    focusable('aria-disabled', { left: 0, top: 0 }, { attributes: { 'aria-disabled': 'true' } })
  ];
  const container = { querySelectorAll: () => candidates };

  assert.deepEqual(getFocusableElements(container).map(element => element.name), ['visible']);
});
