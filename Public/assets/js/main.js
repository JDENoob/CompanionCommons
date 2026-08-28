// Copy Editor System
// Manages editable wording throughout the site
// Only active when the page is loaded with ?edit=true in the URL,
// so regular visitors never see the editor UI.

class CopyEditor {
  constructor() {
    this.storageKey = 'companion-commons-copy';
    this.editMode = new URLSearchParams(window.location.search).get('edit') === 'true';
    this.defaultCopy = this.collectDefaultCopy();
    this.init();
  }

  init() {
    if (this.editMode) {
      this.setupToggle();
      this.setupEditableElements();
      this.setupActions();
    } else {
      this.hideEditorUI();
    }
    this.loadSavedCopy();
  }

  // Hide the edit-wording button/panel entirely for normal visitors
  hideEditorUI() {
    const aside = document.querySelector('.copy-editor');
    if (aside) aside.style.display = 'none';
  }

  // Collect all default copy from the page
  collectDefaultCopy() {
    const copy = {};
    document.querySelectorAll('[data-copy]').forEach(el => {
      const key = el.getAttribute('data-copy');
      copy[key] = el.textContent;
    });
    return copy;
  }

  // Setup toggle button for copy editor
  setupToggle() {
    const toggle = document.querySelector('[data-copy-toggle]');
    const panel = document.querySelector('[data-copy-panel]');

    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => {
      const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', !isExpanded);
      panel.toggleAttribute('hidden');
      document.body.classList.toggle('copy-editing', !isExpanded);
    });
  }

  // Make elements editable
  setupEditableElements() {
    document.querySelectorAll('[data-copy]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (!document.body.classList.contains('copy-editing')) return;
        this.makeEditable(el);
      });
    });
  }

  // Make single element editable
  makeEditable(el) {
    const key = el.getAttribute('data-copy');
    const originalContent = el.textContent;

    // Create input
    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalContent;
    input.style.width = '100%';

    // Replace element content
    const parent = el.parentNode;
    const nextSibling = el.nextSibling;
    parent.removeChild(el);
    parent.insertBefore(input, nextSibling);

    // Focus and select
    input.focus();
    input.select();

    // Handle save on blur or Enter
    const save = () => {
      const newContent = input.value || originalContent;
      parent.removeChild(input);
      el.textContent = newContent;
      parent.insertBefore(el, nextSibling);
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        save();
      } else if (e.key === 'Escape') {
        parent.removeChild(input);
        parent.insertBefore(el, nextSibling);
      }
    });
  }

  // Setup action buttons
  setupActions() {
    const saveBtn = document.querySelector('[data-copy-save]');
    const exportBtn = document.querySelector('[data-copy-export]');
    const resetBtn = document.querySelector('[data-copy-reset]');

    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveCopy());
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportCopy());
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetCopy());
    }
  }

  // Collect current copy from page
  getCurrentCopy() {
    const copy = {};
    document.querySelectorAll('[data-copy]').forEach(el => {
      const key = el.getAttribute('data-copy');
      copy[key] = el.textContent;
    });
    return copy;
  }

  // Save copy to localStorage
  saveCopy() {
    const copy = this.getCurrentCopy();
    localStorage.setItem(this.storageKey, JSON.stringify(copy));
    this.showSavedMessage();
  }

  // Export copy as JSON file
  exportCopy() {
    const copy = this.getCurrentCopy();
    const json = JSON.stringify(copy, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'companion-commons-copy.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  // Reset copy to defaults
  resetCopy() {
    if (!confirm('Reset all copy to defaults? This cannot be undone.')) return;

    document.querySelectorAll('[data-copy]').forEach(el => {
      const key = el.getAttribute('data-copy');
      if (this.defaultCopy[key]) {
        el.textContent = this.defaultCopy[key];
      }
    });

    localStorage.removeItem(this.storageKey);
    this.showSavedMessage('Reset to defaults');
  }

  // Load saved copy from localStorage
  loadSavedCopy() {
    const saved = localStorage.getItem(this.storageKey);
    if (!saved) return;

    try {
      const copy = JSON.parse(saved);
      document.querySelectorAll('[data-copy]').forEach(el => {
        const key = el.getAttribute('data-copy');
        if (copy[key]) {
          el.textContent = copy[key];
        }
      });
    } catch (e) {
      console.error('Error loading saved copy:', e);
    }
  }

  // Show saved confirmation
  showSavedMessage(message = 'Changes saved') {
    const existing = document.querySelector('.copy-saved');
    if (existing) existing.remove();

    const msg = document.createElement('div');
    msg.className = 'copy-saved';
    msg.textContent = message;
    document.body.appendChild(msg);

    setTimeout(() => msg.remove(), 3000);
  }
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new CopyEditor();
  });
} else {
  new CopyEditor();
}

// Additional utilities

// Mobile menu toggle
document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  const header = document.querySelector('[data-header]');

  if (menuToggle && menu) {
    // The CSS's open state is driven by the .is-open class
    // (.site-nav.is-open { display: flex }), and .site-nav itself is
    // display:none unconditionally otherwise -- not gated on the
    // native `hidden` attribute. The nav also never carries `hidden`
    // in the markup to begin with, so the previous `menu.hidden = ...`
    // toggling never matched what the CSS actually responds to and the
    // menu could never visibly open. Toggle the class the CSS expects.
    menuToggle.addEventListener('click', () => {
      const isExpanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', !isExpanded);
      menu.classList.toggle('is-open', !isExpanded);
    });

    // Close menu on link click
    menu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        menuToggle.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
      });
    });
  }

  // FAQ accordion toggle (faqs.html)
  // Each button carries aria-controls pointing at its answer's id; the
  // answer starts with the native `hidden` attribute in markup. Toggling
  // `hidden` and `aria-expanded` together is what the page's CSS actually
  // keys off of (faqs.css flips the +/- glyph on aria-expanded="true").
  // No handler existed for this at all before this fix -- clicking a
  // question did nothing.
  document.querySelectorAll('[data-faq-button]').forEach(button => {
    button.addEventListener('click', () => {
      const isExpanded = button.getAttribute('aria-expanded') === 'true';
      const target = document.getElementById(button.getAttribute('aria-controls'));
      button.setAttribute('aria-expanded', String(!isExpanded));
      if (target) target.hidden = isExpanded;
    });
  });

  // Sticky header on scroll
  let lastScrollTop = 0;
  window.addEventListener('scroll', () => {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    if (header) {
      if (scrollTop > lastScrollTop) {
        // Scrolling down
        header.style.boxShadow = 'none';
      } else {
        // Scrolling up
        header.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
      }
    }
    lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href === '#') return;

      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
});

// Respect prefers-reduced-motion
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (prefersReducedMotion) {
  document.documentElement.style.setProperty('--transition-duration', '0.01ms');
}
