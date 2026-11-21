// Form designer, the PDF side: list, add, change and remove fillable form fields (AcroForm), with
// pdf-lib. Rectangles are PDF user space [x0, y0, x1, y1]; pages are 0-based. Only the fields
// that change get new appearances, so other fields (and their fonts) are left exactly as they were.
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, rgb } from "pdf-lib";

export const FIELD_TYPES = ["text", "multiline", "checkbox", "radio", "dropdown", "list"];
const LABEL = { text: "Text", multiline: "Text", checkbox: "Checkbox", radio: "Choice", dropdown: "Dropdown", list: "List" };
const FIRST_OPTIONS = ["Option 1", "Option 2", "Option 3"];
const LOOK = { borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 1 }; // no background: what's printed under it shows

const typeOf = (f) => (f instanceof PDFTextField ? (f.isMultiline() ? "multiline" : "text")
  : f instanceof PDFCheckBox ? "checkbox" : f instanceof PDFRadioGroup ? "radio"
    : f instanceof PDFDropdown ? "dropdown" : f instanceof PDFOptionList ? "list" : null); // buttons, signatures

async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new Error(/encrypt/i.test(err.message) ? "Forms can't be designed in a password-protected PDF." : `This PDF can't be read: ${err.message}`);
  }
}

// only the fields that changed get new appearances (see the header)
const save = (doc) => doc.save({ updateFieldAppearances: false });

/** Each widget's page, from the pages' annotation lists (a widget's /P is optional). */
function pagesOfWidgets(doc) {
  const pageOf = new Map();
  doc.getPages().forEach((page, i) => {
    for (const ref of page.node.Annots()?.asArray() ?? []) pageOf.set(ref.toString(), i);
  });
  return (widget) => pageOf.get(doc.context.getObjectRef(widget.dict)?.toString()) ?? null;
}

const fontSizeOf = (field) => Number(/([\d.]+)\s+Tf/.exec(field.acroField.getDefaultAppearance?.() ?? "")?.[1] ?? 0) || null;

function valueOf(field, type) {
  if (type === "text" || type === "multiline") return field.getText() ?? "";
  if (type === "checkbox") return field.isChecked();
  if (type === "radio") return field.getSelected() ?? null;
  if (type === "dropdown") return field.getSelected()[0] ?? null;
  return field.getSelected();
}

/**
 * Every widget of every field the designer handles: [{name, type, page, rect, widget (its index
 * in the field), required, value, options?, option? (a radio button's own value), fontSize?}].
 */
export async function listFields(bytes) {
  const doc = await load(bytes);
  const pageOf = pagesOfWidgets(doc);
  const out = [];
  for (const field of doc.getForm().getFields()) {
    const type = typeOf(field);
    if (!type) continue;
    const options = type === "radio" || type === "dropdown" || type === "list" ? field.getOptions() : undefined;
    field.acroField.getWidgets().forEach((widget, i) => {
      const { x, y, width, height } = widget.getRectangle();
      out.push({
        name: field.getName(), type, page: pageOf(widget), rect: [x, y, x + width, y + height], widget: i,
        required: field.isRequired(), value: valueOf(field, type),
        ...(type === "radio" ? { option: options[i], options } : options ? { options } : {}),
        ...(type === "text" || type === "multiline" ? { fontSize: fontSizeOf(field) } : {}),
      });
    });
  }
  return out;
}

/** "Text 3": the type's label and the first number no field uses. */
function freshName(form, type) {
  const used = new Set(form.getFields().map((f) => f.getName()));
  for (let n = 1; ; n++) if (!used.has(`${LABEL[type]} ${n}`)) return `${LABEL[type]} ${n}`;
}

const boxOf = ([x0, y0, x1, y1]) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });

/**
 * Adds a field of `type` on page `page` in `rect`; a radio button with `group` joins that group.
 * @returns {Promise<{bytes: Uint8Array, name: string}>}
 */
export async function addField(bytes, { type, page, rect, name, group }) {
  if (!FIELD_TYPES.includes(type)) throw new Error(`Unknown field type “${type}”.`);
  const doc = await load(bytes);
  const form = doc.getForm();
  const target = doc.getPage(page);
  // pdf-lib grows the widget by half its border on each side; inset so it covers exactly `rect`
  const { x, y, width, height } = boxOf(rect);
  const half = LOOK.borderWidth / 2;
  const box = { x: x + half, y: y + half, width: Math.max(1, width - 2 * half), height: Math.max(1, height - 2 * half), ...LOOK };
  const fieldName = group ?? name ?? freshName(form, type);
  if (!group && form.getFields().some((f) => f.getName() === fieldName)) throw new Error(`A field named “${fieldName}” already exists.`);
  if (type === "text" || type === "multiline") {
    const field = form.createTextField(fieldName);
    if (type === "multiline") field.enableMultiline();
    field.addToPage(target, box);
  } else if (type === "checkbox") {
    form.createCheckBox(fieldName).addToPage(target, box);
  } else if (type === "radio") {
    const field = group ? form.getRadioGroup(group) : form.createRadioGroup(fieldName);
    const taken = new Set(field.getOptions());
    let n = taken.size + 1;
    while (taken.has(`Choice ${n}`)) n++;
    field.addOptionToPage(`Choice ${n}`, target, box);
  } else {
    const field = type === "dropdown" ? form.createDropdown(fieldName) : form.createOptionList(fieldName);
    field.addOptions(FIRST_OPTIONS);
    field.addToPage(target, box);
  }
  return { bytes: await save(doc), name: fieldName };
}

/** Sets a field's value the way its type stores it. */
function setValue(field, type, value) {
  if (type === "text" || type === "multiline") field.setText(value ? String(value) : undefined);
  else if (type === "checkbox") (value ? field.check() : field.uncheck());
  else if (value === null || value === undefined || value === "") field.clear();
  else field.select(value);
}

/**
 * Changes field `name`: {name, required, fontSize, multiline, options, value, rect (with widget:
 * which of its widgets, default 0)}. Only what's given changes.
 */
export async function updateField(bytes, name, changes) {
  const doc = await load(bytes);
  const form = doc.getForm();
  const field = form.getFields().find((f) => f.getName() === name);
  if (!field) throw new Error(`There's no field named “${name}”.`);
  const type = typeOf(field);
  if (changes.rect) field.acroField.getWidgets()[changes.widget ?? 0].setRectangle(boxOf(changes.rect));
  if ("required" in changes) (changes.required ? field.enableRequired() : field.disableRequired());
  if (type === "text" || type === "multiline") {
    if ("multiline" in changes) (changes.multiline ? field.enableMultiline() : field.disableMultiline());
    if (changes.fontSize) field.setFontSize(Number(changes.fontSize));
  }
  if (changes.options && (type === "dropdown" || type === "list")) field.setOptions(changes.options.filter(Boolean));
  if ("value" in changes) setValue(field, type, changes.value);
  if (changes.name && changes.name !== name) {
    if (form.getFields().some((f) => f.getName() === changes.name)) throw new Error(`A field named “${changes.name}” already exists.`);
    field.acroField.setPartialName(changes.name);
  }
  field.defaultUpdateAppearances(form.getDefaultFont());
  return save(doc);
}

/** Removes field `name` and its widgets from every page. */
export async function removeField(bytes, name) {
  const doc = await load(bytes);
  const form = doc.getForm();
  const field = form.getFields().find((f) => f.getName() === name);
  if (!field) throw new Error(`There's no field named “${name}”.`);
  form.removeField(field);
  return save(doc);
}
