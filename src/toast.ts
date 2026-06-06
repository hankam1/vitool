// Тосты (краткие уведомления снизу по центру).

type ToastKind = "success" | "error";

export function toast(message: string, kind: ToastKind = "success", ms = 2000): void {
  const layer = document.getElementById("toast-layer");
  if (!layer) return;

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const iconId = kind === "error" ? "i-warning" : "i-check";
  el.innerHTML = `<svg class="ic"><use href="#${iconId}" /></svg><span></span>`;
  el.querySelector("span")!.textContent = message;
  layer.appendChild(el);

  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 220);
  }, ms);
}
