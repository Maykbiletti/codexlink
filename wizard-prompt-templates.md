# BLUN Website Wizard — Prompt System v1
# Drop-in replacement for engine.js generateContent()

---

## PROBLEM SUMMARY

`/root/blun/src/websites/engine.js` → `generateContent()` is 100% hardcoded.
`/root/blun/admin/lib/website-planner.ts` → `buildWebsiteProposals()` is 100% string interpolation.
Neither file calls any LLM. Zero AI. Manus quality is impossible without fixing this.

---

## FIX: Replace generateContent() in engine.js

### Step 1 — Add BLUN LLM client (top of engine.js)

```js
const BLUN_AI_KEY = process.env.BLUN_AI_KEY || process.env.ANTHROPIC_API_KEY;
const BLUN_AI_BASE = process.env.BLUN_AI_BASE || "https://api.anthropic.com";

async function callLLM(systemPrompt, userPrompt) {
  const res = await fetch(`${BLUN_AI_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": BLUN_AI_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 2000,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt
    })
  });
  if (!res.ok) throw new Error(`LLM error: ${res.status}`);
  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in LLM response");
  return JSON.parse(match[0]);
}
```

### Step 2 — Industry archetype detection

```js
function detectArchetype(businessType, description) {
  const txt = (businessType + " " + description).toLowerCase();
  if (/gym|fitness|sport|training|kraft|studio|boxen|crossfit|pilates|yoga/i.test(txt)) return "gym";
  if (/restaurant|gastronomie|küche|speise|cafe|bar|bistro|catering|kochen|essen|food/i.test(txt)) return "restaurant";
  if (/salon|friseur|beauty|nail|kosmetik|wellness|spa|pflege|haar/i.test(txt)) return "salon";
  if (/hotel|pension|unterkunft|zimmer|übernachtung|ferienwohnung/i.test(txt)) return "hotel";
  return "business"; // fallback
}
```

### Step 3 — System prompts per archetype

```js
const SYSTEM_PROMPTS = {

  gym: `Du bist ein Premium-Webtexter für Fitness-Studios.
Regeln:
- Alle Headlines GROSSGESCHRIEBEN, max 4 Wörter, aggressiv
- Kein "Wir bieten", "Professionell", "Hochwertig" — konkrete Verben statt Adjektive
- IMMER spezifische Zahlen: "2.500 m²" nicht "groß", "40 Kurse/Woche" nicht "viele"
- Ton: direkt, stark, motivierend ("keine Ausreden", "Grenzen verschieben")
- Stats in JetBrains Mono-Stil: echte krumme Zahlen
Ausgabe: NUR valides JSON, kein Text davor/danach.`,

  restaurant: `Du bist ein Premium-Webtexter für gehobene Restaurants.
Regeln:
- Headlines: elegante Substantive, max 5 Wörter, keine Ausrufezeichen
- Kein "lecker", "köstlich", "traumhaft" — kulinarische Fachsprache statt Kitsch
- Gerichte mit echter Zubereitungsmethode + 2-3 Hauptzutaten
- Preise realistisch für die Preisklasse
- Ton: einladend, kultiviert, nie werblich
Ausgabe: NUR valides JSON, kein Text davor/danach.`,

  salon: `Du bist ein Premium-Webtexter für Beauty-Salons und Friseure.
Regeln:
- Headlines: warm, persönlich, max 5 Wörter
- Services mit Dauer (Minuten) + Preis (ab X €) + 1-Satz-Beschreibung
- Kundenstimmen: authentische Namen (keine Muster-Nachnamen), kurze Sätze
- Ton: herzlich, einladend, professionell
Ausgabe: NUR valides JSON, kein Text davor/danach.`,

  business: `Du bist ein Premium-Webtexter für Dienstleistungsunternehmen.
Regeln:
- Kein "Seamless", "Innovative", "Solutions", "Next-Gen"
- Konkrete Prozessschritte statt vager Versprechen
- Team-Namen: echt klingende Namen, keine "Max Mustermann"
- Services mit Ergebnis nicht Beschreibung
- Ton: kompetent, direkt, vertrauenswürdig
Ausgabe: NUR valides JSON, kein Text davor/danach.`
};
```

### Step 4 — User prompts per archetype

```js
const USER_PROMPTS = {

  gym: (siteName, description, location) => `
Generiere Website-Content für Fitnessstudio "${siteName}" in ${location || "Wien"}.
${description ? `Studio-Info: ${description}` : ""}

Ausgabe als JSON:
{
  "hero": {
    "line1": "[VERB/ADJEKTIV CAPS, max 3 Wörter]",
    "line2": "${siteName.toUpperCase()}",
    "line3": "[ACTION CAPS, max 2 Wörter]",
    "tagline": "[max 10 Wörter, konkreter Nutzen, kein Slogan]",
    "stats": [
      {"value": "[z.B. '800+']", "label": "Mitglieder"},
      {"value": "[z.B. '2.500 m²']", "label": "Trainingsfläche"},
      {"value": "[z.B. '40+']", "label": "Kurse/Woche"}
    ],
    "cta": "Jetzt Probetraining"
  },
  "services": [
    {"title": "[CAPS, max 3 Wörter]", "desc": "[2 Sätze, mind. 1 Zahl]"},
    {"title": "[CAPS]", "desc": "[2 Sätze, mind. 1 Zahl]"},
    {"title": "[CAPS]", "desc": "[2 Sätze]"},
    {"title": "[CAPS]", "desc": "[2 Sätze]"},
    {"title": "[CAPS]", "desc": "[2 Sätze]"},
    {"title": "[CAPS]", "desc": "[2 Sätze]"}
  ],
  "about": {
    "headline": "WO ${siteName.toUpperCase().split(" ")[0]} GESCHICHTE SCHREIBT",
    "text": "[3 Sätze, Studio-Geschichte, Philosophie, konkrete Details]",
    "stats": [
      {"value": "[Jahresanzahl+]", "label": "Jahre Erfahrung"},
      {"value": "[Traineranzahl]+", "label": "Zertifizierte Trainer"},
      {"value": "[Mitglied]+", "label": "Aktive Mitglieder"}
    ]
  },
  "pricing": [
    {"name": "Basic", "price": "[X]", "period": "Monat", "features": ["[Feature]", "[Feature]", "[Feature]"]},
    {"name": "Premium", "price": "[X]", "period": "Monat", "features": ["[Feature]", "[Feature]", "[Feature]", "[Feature]"]},
    {"name": "VIP", "price": "[X]", "period": "Monat", "features": ["[Feature]", "[Feature]", "[Feature]", "[Feature]", "[Feature]"]}
  ]
}`,

  restaurant: (siteName, description, location) => `
Generiere Website-Content für Restaurant "${siteName}" in ${location || "Wien"}.
${description ? `Restaurant-Info: ${description}` : ""}

Ausgabe als JSON:
{
  "hero": {
    "headline": "${siteName}",
    "tagline": "[max 6 Wörter, eleganter Stil des Hauses]",
    "cta": "Tisch reservieren"
  },
  "menu": {
    "categories": [
      {
        "title": "Vorspeisen",
        "items": [
          {"name": "[Gerichtsname]", "desc": "[Zubereitung + 2-3 Zutaten, max 10 Wörter]", "price": "€ [X]"},
          {"name": "[Gerichtsname]", "desc": "[...]", "price": "€ [X]"},
          {"name": "[Gerichtsname]", "desc": "[...]", "price": "€ [X]"}
        ]
      },
      {
        "title": "Hauptgänge",
        "items": [
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"},
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"},
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"}
        ]
      },
      {
        "title": "Desserts",
        "items": [
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"},
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"},
          {"name": "[...]", "desc": "[...]", "price": "€ [X]"}
        ]
      }
    ]
  },
  "about": {
    "label": "Unsere Geschichte",
    "headline": "Wo Tradition auf Moderne trifft",
    "para1": "[2-3 Sätze: Lage, Konzept, Chefkoch-Ansatz]",
    "para2": "[2-3 Sätze: Atmosphäre, Anlass, Einladung]",
    "stats": [
      {"value": "[X]+", "label": "Jahre Erfahrung"},
      {"value": "★★★", "label": "Ausgezeichnet"},
      {"value": "100%", "label": "Frische Zutaten"}
    ]
  }
}`,

  salon: (siteName, description, location) => `
Generiere Website-Content für Salon "${siteName}" in ${location || "Wien"}.
${description ? `Info: ${description}` : ""}

Ausgabe als JSON:
{
  "hero": {
    "headline": "[Einladender Slogan, max 5 Wörter]",
    "tagline": "[max 8 Wörter, persönlich]",
    "cta": "Termin buchen"
  },
  "services": [
    {"title": "[Service-Name]", "duration": "[X min]", "price": "ab [X] €", "desc": "[1 Satz]"},
    {"title": "[...]", "duration": "[...]", "price": "[...]", "desc": "[...]"},
    {"title": "[...]", "duration": "[...]", "price": "[...]", "desc": "[...]"},
    {"title": "[...]", "duration": "[...]", "price": "[...]", "desc": "[...]"},
    {"title": "[...]", "duration": "[...]", "price": "[...]", "desc": "[...]"},
    {"title": "[...]", "duration": "[...]", "price": "[...]", "desc": "[...]"}
  ],
  "reviews": [
    {"name": "[Echter Vorname]", "text": "[1-2 Sätze, authentisch]", "rating": 5},
    {"name": "[Echter Vorname]", "text": "[...]", "rating": 5},
    {"name": "[Echter Vorname]", "text": "[...]", "rating": 5}
  ]
}`,

  business: (siteName, description, location) => `
Generiere Website-Content für "${siteName}" in ${location || "Wien"}.
${description ? `Info: ${description}` : ""}

Ausgabe als JSON:
{
  "hero": {
    "headline": "[Konkreter Nutzen, max 6 Wörter]",
    "tagline": "[max 10 Wörter, Ergebnis für Kunde]",
    "cta": "Jetzt anfragen"
  },
  "services": [
    {"title": "[Service]", "desc": "[1-2 Sätze, konkretes Ergebnis]"},
    {"title": "[...]", "desc": "[...]"},
    {"title": "[...]", "desc": "[...]"},
    {"title": "[...]", "desc": "[...]"}
  ],
  "process": [
    {"step": "01", "title": "[Schritt]", "desc": "[1 Satz]"},
    {"step": "02", "title": "[...]", "desc": "[...]"},
    {"step": "03", "title": "[...]", "desc": "[...]"}
  ],
  "team": [
    {"name": "[Echter Name]", "role": "[Rolle]", "bio": "[1 Satz Kernkompetenz]"},
    {"name": "[...]", "role": "[...]", "bio": "[...]"}
  ]
}`
};
```

### Step 5 — New generateContent() function

```js
async function generateContent(templateSlug, siteName, description, extraData) {
  var tpl = getTemplateBySlug(templateSlug);
  if (!tpl) throw new Error("Unknown template: " + templateSlug);

  var businessType = extraData?.businessType || templateSlug;
  var location = extraData?.location || "";
  var archetype = detectArchetype(businessType, description || "");

  var systemPrompt = SYSTEM_PROMPTS[archetype] || SYSTEM_PROMPTS.business;
  var userPrompt = USER_PROMPTS[archetype]
    ? USER_PROMPTS[archetype](siteName, description || "", location)
    : USER_PROMPTS.business(siteName, description || "", location);

  try {
    var aiContent = await callLLM(systemPrompt, userPrompt);
    return {
      siteName: siteName,
      description: description,
      template: templateSlug,
      archetype: archetype,
      sections: aiContent,
      generated_by: "claude-opus"
    };
  } catch (err) {
    console.error("[engine] LLM call failed, falling back to stub:", err.message);
    // Return minimal fallback so site still builds
    return {
      siteName: siteName,
      description: description,
      template: templateSlug,
      archetype: "fallback",
      sections: { hero: { headline: siteName, tagline: description || "Willkommen" } }
    };
  }
}
```

---

## ARCHETYPE VISUAL SYSTEMS (for template CSS)

### gym
```css
--font-display: 'Bebas Neue', sans-serif;
--font-mono: 'JetBrains Mono', monospace;
--bg: oklch(0.08 0.01 270);
--accent: oklch(0.78 0.15 168);   /* electric cyan */
--text: oklch(0.92 0.01 270);
--border-radius: 2px;
/* + grain overlay: fixed inset-0 opacity-[0.04] pointer-events-none */
```

### restaurant
```css
--font-display: 'Cormorant Garamond', serif;
--font-body: 'Lato', sans-serif;
--bg: oklch(0.97 0.008 80);
--accent: oklch(0.72 0.12 75);    /* warm gold */
--text: oklch(0.15 0.01 60);
--border-radius: 0;
/* + art-deco corners: absolute border-1px-gold/30 w-20 h-20 */
```

### salon
```css
--font-display: 'Playfair Display', serif;
--font-body: 'Nunito', sans-serif;
--bg: oklch(0.97 0.01 340);
--accent: oklch(0.65 0.12 340);   /* dusty rose */
--border-radius: 12px;
```

### business
```css
--font-display: 'Outfit', sans-serif;
--bg: oklch(0.98 0.005 240);
--accent: oklch(0.45 0.18 250);   /* deep electric blue */
--border-radius: 6px;
```

---

## SECTION SCHEMAS per archetype

| Archetype | Sections |
|---|---|
| gym | Hero → Angebot (6 services) → Kursplan → Preise → Team → Über uns → CTA → Kontakt |
| restaurant | Hero → Speisekarte (3×3) → Galerie → Über uns → Reservierung → Footer |
| salon | Hero → Services (6 items mit Preis+Dauer) → Team → Bewertungen → Preisliste → Kontakt |
| business | Hero → Leistungen → Prozess (3 Steps) → Referenzen → Team → Kontakt |

---

## PEXELS IMAGE QUERIES per archetype

```js
const PEXELS_QUERIES = {
  gym: ["gym weightlifting dark", "fitness class group", "personal trainer"],
  restaurant: ["fine dining interior", "gourmet food plated", "restaurant kitchen"],
  salon: ["hair salon modern", "beauty treatment", "nail art studio"],
  business: ["modern office", "business meeting", "professional workspace"]
};
```

---

## ENV VARS REQUIRED

```
BLUN_AI_KEY=<BLUN gateway key or ANTHROPIC_API_KEY>
BLUN_AI_BASE=https://api.anthropic.com  # or BLUN gateway URL
PEXELS_API_KEY=<existing key>
```
