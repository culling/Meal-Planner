// Print what the importer extracts from saved fixtures. Usage: tsx scripts/peek-fixture.mts butter-chicken [more...]
import fs from "node:fs";
import path from "node:path";
import { draftFromHtml } from "../src/jsonld.ts";

for (const name of process.argv.slice(2)) {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "test", "fixtures", `${name}.html`), "utf8");
  const r = draftFromHtml(html, `https://www.recipetineats.com/${name}/`, { fridgeDays: 3 });
  console.log(`\n===== ${name}`);
  if (!r) {
    console.log("NO RECIPE FOUND");
    continue;
  }
  const d = r.draft;
  console.log(JSON.stringify({ title: d.title, servings: d.servings, times: d.times, tags: d.tags, course: d.course, cuisine: d.cuisine, author: d.source.author }));
  console.log("ingredients:", d.ingredientsMd.split("\n").slice(0, 5).join(" | "));
  console.log("method:", d.methodMd.split("\n").length, "steps; first:", d.methodMd.split("\n")[0].slice(0, 100));
  console.log("nutrition:", JSON.stringify(d.nutrition?.perServing));
  console.log("leftovers:", JSON.stringify(d.leftovers));
  console.log("warnings:", d.warnings);
  console.log("notes:", d.sourceNotes.slice(0, 260).replace(/\n+/g, " | "));
  console.log("image:", r.imageUrl);
}
