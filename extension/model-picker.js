import { PROVIDERS } from "./settings.js";

const CUSTOM = "custom";

// Binds the provider <select>, the model <select> and the text box shown for
// "직접 입력" to settings, saving each change. The bridge validates model names.
export function bindModelPicker({ provider, model, customModel }, settings, onSaved = () => {}) {
  for (const [id, { label }] of Object.entries(PROVIDERS)) {
    provider.add(new Option(label, id, false, id === settings.provider));
  }

  const show = () => {
    const { models } = PROVIDERS[provider.value];
    const current = settings.models[provider.value] ?? "";
    const listed = models.some(({ value }) => value === current);
    model.replaceChildren(
      ...models.map(({ value, label }) => new Option(label, value)),
      new Option("직접 입력…", CUSTOM),
    );
    model.value = listed ? current : CUSTOM;
    customModel.value = listed ? "" : current;
    customModel.hidden = listed;
  };

  const save = async (value) => {
    settings.models = { ...settings.models, [provider.value]: value };
    await chrome.storage.local.set({ models: settings.models });
    onSaved();
  };

  show();
  provider.addEventListener("change", async () => {
    settings.provider = provider.value;
    show();
    await chrome.storage.local.set({ provider: settings.provider });
    onSaved();
  });
  model.addEventListener("change", () => {
    if (model.value === CUSTOM) {
      customModel.hidden = false;
      customModel.focus();
      return;
    }
    customModel.hidden = true;
    save(model.value);
  });
  customModel.addEventListener("change", () => save(customModel.value.trim()));
}
