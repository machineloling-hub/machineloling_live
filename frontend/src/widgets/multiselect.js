import { $, champImg } from "../utils.js";
import { refresh } from "../main.js";

// ──────────────────────────────────────────────────────────────────────────
// POOL CHIP MULTI-SELECT (sidebar + builder definite/maybe)
// ──────────────────────────────────────────────────────────────────────────
function makeMultiSelect({ chipsId, searchId, suggestionsId, getList, getSelected, setSelected, max }) {
  const chips = $(chipsId);
  const search = $(searchId);
  const sugg = $(suggestionsId);
  let active = -1;

  const renderChips = () => {
    chips.innerHTML = getSelected().map((c) => `
      <span class="pool-chip">${champImg(c, 16)}${c}<span class="x" data-c="${c}">×</span></span>
    `).join("");
    chips.querySelectorAll(".x").forEach((el) =>
      el.addEventListener("click", (e) => {
        const c = e.target.dataset.c;
        setSelected(getSelected().filter((x) => x !== c));
        renderChips();
        refresh();
      })
    );
  };

  const renderSuggs = (q) => {
    const list = getList();
    const ql = q.toLowerCase().trim();
    const sel = new Set(getSelected());
    const cands = list.filter((c) => !sel.has(c.champion) &&
                                      (ql === "" || c.champion.toLowerCase().includes(ql)))
                       .slice(0, 30);
    if (cands.length === 0) { sugg.classList.remove("open"); sugg.innerHTML = ""; return; }
    sugg.innerHTML = cands.map((c, i) => `
      <div class="suggestion ${i === active ? "active" : ""}" data-c="${c.champion}">
        ${champImg(c.champion, 18)} <span>${c.champion}</span>
        <span class="pr">${(c.pick_rate * 100).toFixed(1)}%</span>
      </div>`).join("");
    sugg.classList.add("open");
    sugg.querySelectorAll(".suggestion").forEach((el) =>
      el.addEventListener("mousedown", () => addOne(el.dataset.c))
    );
  };

  const addOne = (ch) => {
    if (max && getSelected().length >= max) return;
    if (getSelected().includes(ch)) return;
    setSelected([...getSelected(), ch]);
    search.value = ""; active = -1;
    renderChips();
    sugg.classList.remove("open");
    refresh();
  };

  search.addEventListener("input", (e) => { active = -1; renderSuggs(e.target.value); });
  search.addEventListener("focus", (e) => renderSuggs(e.target.value));
  search.addEventListener("blur", () => setTimeout(() => sugg.classList.remove("open"), 150));
  search.addEventListener("keydown", (e) => {
    const items = sugg.querySelectorAll(".suggestion");
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderSuggs(search.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); renderSuggs(search.value); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); addOne(items[active].dataset.c); }
    else if (e.key === "Escape") { sugg.classList.remove("open"); }
  });

  return { renderChips };
}

// Single-select sibling of makeMultiSelect — one chip + search input +
// suggestion dropdown. Picking a suggestion replaces the current selection
// and triggers refresh().
function makeSingleSelect({ chipId, searchId, suggestionsId, getList, getSelected, setSelected }) {
  const chip = $(chipId);
  const search = $(searchId);
  const sugg = $(suggestionsId);
  let active = -1;

  const renderChip = () => {
    const sel = getSelected();
    if (!sel) {
      chip.innerHTML = '<span class="pool-chip" style="opacity:0.5;">— pick a champion —</span>';
      return;
    }
    chip.innerHTML = `<span class="pool-chip">${champImg(sel, 16)}${sel}</span>`;
  };

  const renderSuggs = (q) => {
    const list = getList();
    const ql = q.toLowerCase().trim();
    const sel = getSelected();
    const cands = list.filter((c) => c.champion !== sel &&
                                      (ql === "" || c.champion.toLowerCase().includes(ql)))
                       .slice(0, 30);
    if (cands.length === 0) { sugg.classList.remove("open"); sugg.innerHTML = ""; return; }
    sugg.innerHTML = cands.map((c, i) => `
      <div class="suggestion ${i === active ? "active" : ""}" data-c="${c.champion}">
        ${champImg(c.champion, 18)} <span>${c.champion}</span>
        <span class="pr">${(c.pick_rate * 100).toFixed(1)}%</span>
      </div>`).join("");
    sugg.classList.add("open");
    sugg.querySelectorAll(".suggestion").forEach((el) =>
      el.addEventListener("mousedown", () => choose(el.dataset.c))
    );
  };

  const choose = (ch) => {
    setSelected(ch);
    search.value = ""; active = -1;
    renderChip();
    sugg.classList.remove("open");
    refresh();
  };

  search.addEventListener("input", (e) => { active = -1; renderSuggs(e.target.value); });
  search.addEventListener("focus", (e) => renderSuggs(e.target.value));
  search.addEventListener("blur", () => setTimeout(() => sugg.classList.remove("open"), 150));
  search.addEventListener("keydown", (e) => {
    const items = sugg.querySelectorAll(".suggestion");
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderSuggs(search.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); renderSuggs(search.value); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active].dataset.c); }
    else if (e.key === "Escape") { sugg.classList.remove("open"); }
  });

  return { renderChip };
}

// ──────────────────────────────────────────────────────────────────────────
// INIT

export { makeMultiSelect, makeSingleSelect };
