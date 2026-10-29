import { t } from "./i18n.js";
import { PROVIDERS } from "./settings.js";

const CUSTOM = "custom";

// Binds the provider <select>, the model <select> and the text box shown for
// the custom entry to settings, saving each change. The bridge validates model names.
export function bindModelPicker({ provider, model, customModel }, settings, onSaved = () => {}) {
  for (const [id, { label }] of Object.entries(PROVIDERS)) {
    provider.add(new Option(label, id, false, id === settings.provider));
  }

  const render = (models) => {
    const current = settings.models[provider.value] ?? "";
    const listed = models.some(({ value }) => value === current);
    model.replaceChildren(
      ...models.map(({ value, label }) => new Option(label, value)),
      new Option(t("customModel"), CUSTOM),
    );
    model.value = listed ? current : CUSTOM;
    customModel.value = listed ? "" : current;
    customModel.hidden = listed;
  };

  // Shows the fixed choices at once, then adds the models the provider's tool
  // reports for the account when it can list them.
  const show = async () => {
    const id = provider.value;
    const { models, listsModels } = PROVIDERS[id];
    render(models);
    if (!listsModels) return;
    const reply = await chrome.runtime.sendMessage({ type: "byos:models", provider: id });
    if (provider.value !== id || !reply?.models?.length || document.activeElement === customModel) return;
    render([
      ...models,
      ...reply.models.map(({ id: value, label, isDefault }) => ({ value, label: isDefault ? `${label} · ${t("modelDefault")}` : label })),
    ]);
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
