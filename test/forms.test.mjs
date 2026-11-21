import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { listFields, addField, updateField, removeField, FIELD_TYPES } from "../src/forms.js";

const blank = async (pages = 2) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]);
  return doc.save();
};
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

/** The form widgets MuPDF finds (another PDF engine): [page, field name, type]. */
function widgetsSeenByMuPDF(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  const out = [];
  for (let p = 0; p < doc.countPages(); p++) for (const w of doc.loadPage(p).getWidgets()) out.push([p, w.getName(), w.getFieldType()]);
  return out;
}

test("every kind of field is placed where it was drawn, as a real PDF form field", async () => {
  let bytes = await blank();
  const rects = {};
  for (const [i, type] of FIELD_TYPES.entries()) {
    const rect = [72, 700 - i * 60, 272, 730 - i * 60];
    rects[type] = rect;
    ({ bytes } = await addField(bytes, { type, page: 1, rect }));
  }
  const fields = await listFields(bytes);
  assert.deepEqual(fields.map((f) => f.type), FIELD_TYPES);
  for (const f of fields) {
    assert.equal(f.page, 1);
    assert.ok(near(f.rect, rects[f.type]), `${f.type} at ${f.rect}`);
  }
  assert.equal(new Set(fields.map((f) => f.name)).size, fields.length, "names are unique");
  assert.deepEqual(widgetsSeenByMuPDF(bytes).map(([p, , t]) => [p, t]),
    [[1, "text"], [1, "text"], [1, "checkbox"], [1, "radiobutton"], [1, "combobox"], [1, "listbox"]]);
});

test("names follow the type and never repeat", async () => {
  let bytes = await blank(1);
  const names = [];
  for (let i = 0; i < 3; i++) {
    const added = await addField(bytes, { type: "text", page: 0, rect: [72, 700 - i * 40, 272, 720 - i * 40] });
    bytes = added.bytes;
    names.push(added.name);
  }
  assert.deepEqual(names, ["Text 1", "Text 2", "Text 3"]);
});

test("a field's properties can be changed: name, required, font size, options and value", async () => {
  let { bytes, name } = await addField(await blank(1), { type: "dropdown", page: 0, rect: [72, 700, 272, 724] });
  bytes = await updateField(bytes, name, { name: "Country", required: true, options: ["Bangladesh", "India", "Nepal"], value: "Nepal" });
  ({ bytes } = await addField(bytes, { type: "text", page: 0, rect: [72, 600, 272, 624] }));
  bytes = await updateField(bytes, "Text 1", { fontSize: 14, value: "Hello", multiline: true });
  const [country, text] = await listFields(bytes);
  assert.deepEqual([country.name, country.required, country.options, country.value], ["Country", true, ["Bangladesh", "India", "Nepal"], "Nepal"]);
  assert.deepEqual([text.type, text.fontSize, text.value], ["multiline", 14, "Hello"]);
});

test("a field can be moved and resized, and removed", async () => {
  let { bytes, name } = await addField(await blank(1), { type: "checkbox", page: 0, rect: [72, 700, 90, 718] });
  bytes = await updateField(bytes, name, { rect: [300, 400, 330, 430] });
  assert.ok(near((await listFields(bytes))[0].rect, [300, 400, 330, 430]));
  bytes = await removeField(bytes, name);
  assert.deepEqual(await listFields(bytes), []);
  assert.deepEqual(widgetsSeenByMuPDF(bytes), [], "no widget left behind");
});

test("radio buttons placed into a group are one field with one value per button", async () => {
  let { bytes, name } = await addField(await blank(1), { type: "radio", page: 0, rect: [72, 700, 88, 716] });
  ({ bytes } = await addField(bytes, { type: "radio", page: 0, rect: [72, 670, 88, 686], group: name }));
  ({ bytes } = await addField(bytes, { type: "radio", page: 0, rect: [72, 640, 88, 656], group: name }));
  const buttons = await listFields(bytes);
  assert.deepEqual(buttons.map((b) => b.name), [name, name, name]);
  assert.deepEqual(buttons.map((b) => b.widget), [0, 1, 2]);
  assert.equal(new Set(buttons.map((b) => b.option)).size, 3, "each button has its own value");
  bytes = await updateField(bytes, name, { rect: [100, 640, 116, 656], widget: 2 });
  assert.ok(near((await listFields(bytes))[2].rect, [100, 640, 116, 656]), "one button moves alone");
});

test("fields already in a PDF are listed with their values", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();
  const tf = form.createTextField("full.name");
  tf.setText("Ada");
  tf.addToPage(page, { x: 72, y: 700, width: 200, height: 20 });
  const cb = form.createCheckBox("agree");
  cb.addToPage(page, { x: 72, y: 660, width: 14, height: 14 });
  cb.check();
  const fields = await listFields(await doc.save());
  assert.deepEqual(fields.map((f) => [f.name, f.type, f.value]), [["full.name", "text", "Ada"], ["agree", "checkbox", true]]);
});
