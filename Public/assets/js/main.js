const toggle = document.querySelector("[data-menu-toggle]");
const menu = document.querySelector("[data-menu]");
if (toggle && menu) {
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    menu.classList.toggle("is-open", !open);
  });
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      toggle.setAttribute("aria-expanded", "false");
      menu.classList.remove("is-open");
    }
  });
}

const copyToggle = document.querySelector("[data-copy-toggle]");
const copyPanel = document.querySelector("[data-copy-panel]");
const pageName = (location.pathname.split("/").pop() || "index.html").replace(
  /\.html$/,
  "",
);
const storageKey = `companionCommonsCopyV1:${pageName}`;

// Make all meaningful visible wording editable while protecting controls,
// decorative artwork, and the copy editor itself.
const editableSelectors = [
  ".brand-name",
  ".site-nav a:not(.button)",
  ".site-nav .button",
  ".hero-copy .eyebrow",
  ".hero-copy h1",
  ".hero-intro",
  ".button-row .button",
  ".trust-list li",
  ".portrait-main p",
  ".founder-badge strong",
  ".founder-badge span",
  ".impact-grid h2",
  ".impact-item small",
  ".impact-item strong",
  ".section-heading .eyebrow",
  ".section-heading h2",
  ".section-heading > p:last-child",
  ".card-kicker",
  ".value-content h3",
  ".value-content > p",
  ".check-list li",
  ".text-link",
  ".dashboard-showcase h2",
  ".dashboard-showcase h3",
  ".dashboard-showcase h4",
  ".dashboard-showcase p",
  ".dashboard-showcase li",
  ".dashboard-showcase .button",
  ".dashboard-privacy span",
  ".dashboard-disclaimer",
  ".independence-callout .eyebrow",
  ".independence-callout h3",
  ".independence-callout p:last-child",
  ".review-marker p",
  ".review-marker h2",
  ".page-hero .eyebrow",
  ".page-hero h1",
  ".page-hero p",
  ".page-hero .button",
  ".content-section .eyebrow",
  ".content-section h2",
  ".content-section h3",
  ".content-section p",
  ".content-section li",
  ".content-section .button",
  ".content-section .text-link",
  ".site-footer h2",
  ".site-footer p",
  ".site-footer a",
  ".founder-portrait p",
  ".founder-copy blockquote",
  ".founder-copy .eyebrow",
  ".founder-copy h1",
  ".founder-copy > p:not(.eyebrow)",
  ".mission-section .eyebrow",
  ".mission-section h2",
  ".mission-section p",
  ".faq-group h2",
  ".faq-question span",
  ".faq-answer p",
  ".faq-intro p",
];

const allEditable = [...document.querySelectorAll(editableSelectors.join(","))];
allEditable.forEach((element, index) => {
  if (!element.dataset.copy) {
    const hint =
      (element.textContent || "copy")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 36) || "copy";
    element.dataset.copy = `page.${String(index + 1).padStart(2, "0")}.${hint}`;
  }
});

const copyElements = [...document.querySelectorAll("[data-copy]")];
const originalCopy = Object.fromEntries(
  copyElements.map((element) => [element.dataset.copy, element.innerHTML]),
);

function collectCopy() {
  return Object.fromEntries(
    copyElements.map((element) => [
      element.dataset.copy,
      element.innerHTML.trim(),
    ]),
  );
}
function applyCopy(copy) {
  copyElements.forEach((element) => {
    if (copy[element.dataset.copy] !== undefined)
      element.innerHTML = copy[element.dataset.copy];
  });
}
function notify(message) {
  const notice = document.createElement("div");
  notice.className = "copy-saved";
  notice.textContent = message;
  document.body.append(notice);
  setTimeout(() => notice.remove(), 1800);
}
function setEditing(editing) {
  document.body.classList.toggle("copy-editing", editing);
  copyElements.forEach(
    (element) => (element.contentEditable = String(editing)),
  );
  copyToggle.setAttribute("aria-expanded", String(editing));
  copyToggle.innerHTML = editing
    ? "✓ Finish editing"
    : '<span aria-hidden="true">✎</span> Edit wording';
  copyPanel.hidden = !editing;
}

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved) applyCopy(saved);
} catch (error) {
  console.warn("Saved copy could not be loaded.", error);
}
if (copyToggle)
  copyToggle.addEventListener("click", () =>
    setEditing(!document.body.classList.contains("copy-editing")),
  );
document.querySelector("[data-copy-save]")?.addEventListener("click", () => {
  localStorage.setItem(storageKey, JSON.stringify(collectCopy()));
  notify("Wording saved in this browser");
});
document.querySelector("[data-copy-export]")?.addEventListener("click", () => {
  const file = new Blob([JSON.stringify(collectCopy(), null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `companion-commons-${pageName}-wording.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  notify("Wording file exported");
});
document.querySelector("[data-copy-reset]")?.addEventListener("click", () => {
  applyCopy(originalCopy);
  localStorage.removeItem(storageKey);
  notify("Original wording restored");
});

document.querySelectorAll("[data-faq-button]").forEach((button) => {
  button.addEventListener("click", () => {
    if (document.body.classList.contains("copy-editing")) return;
    const expanded = button.getAttribute("aria-expanded") === "true";
    const answer = document.getElementById(
      button.getAttribute("aria-controls"),
    );
    button.setAttribute("aria-expanded", String(!expanded));
    if (answer) answer.hidden = expanded;
  });
});
