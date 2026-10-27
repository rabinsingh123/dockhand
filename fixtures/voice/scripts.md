# Voice note scripts

Three short code-switched (Portuguese/English) voice notes for the demo and the intake tests. Everything in them is fictional and matches the referral photos in `fixtures/inbound/`.

How to record:

- Record each one as a WhatsApp voice note on a phone (OGG/Opus), at a normal pace, in a quiet room. Speakers must be people who agreed to be recorded.
- Save the files as `fixtures/voice/<id>.ogg`. The rep forwards them to Dockhand from Ana Ribeiro's number.
- Read the script as written. The "say as" lines show how to pronounce emails and numbers.

Expected values assume "today" is 2026-10-27 in America/Sao_Paulo. A month without a day ("começando em janeiro") resolves to the first day of the next such month. `summaryForRep` is free text and is not graded. The same data is in `expected.json`.

## 1. Partner asks the rep to register Café Aurora

- id: `vn1-register-cafe-aurora` (save as `fixtures/voice/vn1-register-cafe-aurora.ogg`)
- Speaker: Marcos Tavares (Rota Consultoria, referral partner). Forwarded by Ana Ribeiro (rep).

> Oi Ana, é o Marcos, da Rota Consultoria. Registra aí pra mim um deal novo: Café Aurora, vinte e cinco seats do Business, em São Paulo. Fecha em janeiro, dia vinte e nove. The contact is Júlia Prado, julia at cafeaurora dot example. Valeu!

Say as:

- "julia at cafeaurora dot example" → julia@cafeaurora.example
- "vinte e cinco seats do Business" → 25 seats, Tidewater Cloud Business
- "janeiro, dia vinte e nove" → 2027-01-29

Expected `Understanding`:

```json
{
  "intent": "register_deal",
  "language": "pt",
  "company": "Café Aurora",
  "city": "São Paulo",
  "country": "Brazil",
  "seats": 25,
  "startDate": null,
  "contactName": "Júlia Prado",
  "contactEmail": "julia@cafeaurora.example",
  "contactPhone": null,
  "product": "Tidewater Cloud Business",
  "estValue": null,
  "closeDate": "2027-01-29",
  "website": null,
  "referralPartner": "Rota Consultoria",
  "notes": null,
  "portalUrl": null,
  "tenant": null,
  "inviteCode": null,
  "buyerName": null,
  "missing": [],
  "summaryForRep": "Registrar a Café Aurora (São Paulo) na Caravela: 25 seats do Tidewater Cloud Business, fechamento em 29/01/2027, contato Júlia Prado. Indicação da Rota Consultoria."
}
```

## 2. Buyer asks for pricing (quote, API path)

- id: `vn2-quote-cafe-aurora` (save as `fixtures/voice/vn2-quote-cafe-aurora.ogg`)
- Speaker: Júlia Prado (Café Aurora, buyer). Forwarded by Ana Ribeiro (rep).

> Oi Ana, aqui é a Júlia, do Café Aurora. Can you send pricing for 25 people em São Paulo, começando em janeiro? A gente tá pensando no plano Business. Obrigada!

Say as:

- "twenty-five people" → 25 seats
- "começando em janeiro" → startDate 2027-01-01 (month only: first day of the next January)

Expected `Understanding`:

```json
{
  "intent": "quote",
  "language": "pt",
  "company": "Café Aurora",
  "city": "São Paulo",
  "country": "Brazil",
  "seats": 25,
  "startDate": "2027-01-01",
  "contactName": "Júlia",
  "contactEmail": null,
  "contactPhone": null,
  "product": "Tidewater Cloud Business",
  "estValue": null,
  "closeDate": null,
  "website": null,
  "referralPartner": null,
  "notes": null,
  "portalUrl": null,
  "tenant": null,
  "inviteCode": null,
  "buyerName": null,
  "missing": [],
  "summaryForRep": "Cotação para a Café Aurora: 25 usuários do Tidewater Cloud Business em São Paulo, início em janeiro de 2027."
}
```

## 3. Partner registration with the seat count missing (triggers a follow-up question)

- id: `vn3-register-vila-nova-missing-seats` (save as `fixtures/voice/vn3-register-vila-nova-missing-seats.ogg`)
- Speaker: Marcos Tavares (Rota Consultoria, referral partner). Forwarded by Ana Ribeiro (rep).

> Ana, mais uma do Marcos, da Rota Consultoria. Registra a Vila Nova Logística, lá em Curitiba, plano Business. O fechamento é dia vinte e seis de fevereiro. The contact person é a Helena Kowalski, helena at vilanovalog dot example. Depois te mando o form assinado.

Say as:

- "helena at vilanovalog dot example" → helena@vilanovalog.example
- "Kowalski (say it naturally, ko-VAL-ski)" → Kowalski
- "dia vinte e seis de fevereiro" → 2027-02-26

Expected `Understanding`:

```json
{
  "intent": "register_deal",
  "language": "pt",
  "company": "Vila Nova Logística",
  "city": "Curitiba",
  "country": "Brazil",
  "seats": null,
  "startDate": null,
  "contactName": "Helena Kowalski",
  "contactEmail": "helena@vilanovalog.example",
  "contactPhone": null,
  "product": "Tidewater Cloud Business",
  "estValue": null,
  "closeDate": "2027-02-26",
  "website": null,
  "referralPartner": "Rota Consultoria",
  "notes": null,
  "portalUrl": null,
  "tenant": null,
  "inviteCode": null,
  "buyerName": null,
  "missing": [
    "seats"
  ],
  "summaryForRep": "Registrar a Vila Nova Logística (Curitiba) na Caravela: Tidewater Cloud Business, fechamento em 26/02/2027, contato Helena Kowalski. Falta o número de seats."
}
```

Follow-up: `missing` is `["seats"]`, so Dockhand asks one question before planning, for example "Quantos seats a Vila Nova Logística vai contratar?". The rep answers "Quarenta.", which sets `seats` to 40 and clears `missing`.
