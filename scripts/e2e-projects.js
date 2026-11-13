'use strict';

// playwright.config.ts's projects, the two sizes ux-review checks; scripts/e2e.js records a pass per project.
module.exports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
