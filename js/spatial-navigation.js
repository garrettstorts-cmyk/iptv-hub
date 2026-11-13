(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.IPTVSpatialNavigation = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  const FOCUSABLE_SELECTOR = "button, input, select, textarea, a[href], [tabindex='0'], [contenteditable='true']";

  function getFocusableElements(container) {
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(element => {
      if (element.disabled || element.getAttribute("aria-disabled") === "true" || element.tabIndex < 0) return false;

      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.inert || ancestor.getAttribute("aria-hidden") === "true") return false;
        const style = root.getComputedStyle?.(ancestor);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0")) {
          return false;
        }
      }

      if (!element.getClientRects().length) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function findNextFocusable(currentElement, direction, candidates) {
    const axes = {
      up: { primary: "y", perpendicular: "x", sign: -1 },
      down: { primary: "y", perpendicular: "x", sign: 1 },
      left: { primary: "x", perpendicular: "y", sign: -1 },
      right: { primary: "x", perpendicular: "y", sign: 1 }
    };
    const axis = axes[direction];
    if (!axis || !currentElement) return null;

    const current = currentElement.getBoundingClientRect();
    const currentCenter = axis.primary === "x"
      ? (current.left + current.right) / 2
      : (current.top + current.bottom) / 2;
    const currentCrossStart = axis.perpendicular === "x" ? current.left : current.top;
    const currentCrossEnd = axis.perpendicular === "x" ? current.right : current.bottom;
    const directional = [];

    for (const element of candidates) {
      if (!element || element === currentElement) continue;
      const rect = element.getBoundingClientRect();
      const center = axis.primary === "x" ? (rect.left + rect.right) / 2 : (rect.top + rect.bottom) / 2;
      const primaryDistance = (center - currentCenter) * axis.sign;
      if (primaryDistance <= 0) continue;

      const crossStart = axis.perpendicular === "x" ? rect.left : rect.top;
      const crossEnd = axis.perpendicular === "x" ? rect.right : rect.bottom;
      const overlaps = currentCrossStart < crossEnd && currentCrossEnd > crossStart;
      const perpendicularDistance = overlaps
        ? 0
        : Math.max(currentCrossStart - crossEnd, crossStart - currentCrossEnd, 0);

      directional.push({
        element,
        aligned: overlaps,
        primaryDistance,
        perpendicularDistance,
        score: primaryDistance + perpendicularDistance * 2
      });
    }

    if (!directional.length) return null;
    const aligned = directional.filter(candidate => candidate.aligned);
    const pool = aligned.length ? aligned : directional;
    pool.sort((first, second) =>
      first.score - second.score ||
      first.perpendicularDistance - second.perpendicularDistance ||
      first.primaryDistance - second.primaryDistance
    );
    return pool[0].element;
  }

  return Object.freeze({ getFocusableElements, findNextFocusable });
});
