import { PROVIDERS } from "./settings.js";

// Binds a provider <select>, a model <input> and its <datalist> to settings and
// saves each change. The bridge validates the model; an empty model means the
// provider's default.
export function bindModelPicker({ provider, model, suggestions }, settings, onSaved = () => {}) {
  for (const [id, { label }] of Object.entries(PROVIDERS)) {
    provider.add(new Option(label, id, false, id === settings.provider));
  }
  const show = () => {
    model.value = settings.models[provider.value] ?? "";
    model.placeholder = "기본 모델";
    suggestions.replaceChildren(...PROVIDERS[provider.value].suggestions.map((value) => new Option(value, value)));
  };
  show();
  provider.addEventListener("change", async () => {
    settings.provider = provider.value;
    show();
    await chrome.storage.local.set({ provider: settings.provider });
    onSaved();
  });
  model.addEventListener("change", async () => {
    settings.models = { ...settings.models, [provider.value]: model.value.trim() };
    await chrome.storage.local.set({ models: settings.models });
    onSaved();
  });
}
