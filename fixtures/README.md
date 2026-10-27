# Fixtures

Synthetic test and demo assets for Dockhand. Everything here is made up: Tidewater Cloud, Caravela, Acme Group, Globex Industrial, Rota Consultoria, Harbor Mutual, every customer, every person, every ID and number. No real people, tax IDs, bank numbers, logos or copyrighted form layouts.

## Assets

| Path | What it is | Ground truth |
|---|---|---|
| `profile/tidewater.json` | Tidewater Cloud's supplier-onboarding profile, keyed by the supplier portal's canonical field keys (`SUPPLIER_FIELDS` in `apps/portals`). Values are strings in the format the portal accepts; checkboxes are `"true"`/`"false"`; files are workspace-relative paths. | Itself (checked against the portal's field list, options and patterns at generation time) |
| `reps/rep.json` | The demo rep, Ana Ribeiro (`RepProfile`). | |
| `docs/w9-sample.pdf` | One-page W-9-style form for Tidewater Cloud, drawn from scratch (not the IRS layout), with a fake TIN and a diagonal "SAMPLE – SYNTHETIC TEST DOCUMENT" watermark. Upload for the supplier portal's W-9 field. | Values come from `profile/tidewater.json` |
| `docs/insurance-certificate-sample.pdf` | Certificate of insurance in our own layout (not ACORD 25), insurer "Harbor Mutual (fictional)", policy numbers `SAMPLE-GL-0001` and similar, same watermark. | Same |
| `inbound/referral-cafe-aurora.jpg`, `inbound/referral-vila-nova.jpg` | Phone photos (1600×2133 JPEG) of a signed, hand-filled Tidewater partner referral form sent in by Rota Consultoria. Flow 2 input. | `*.expected.json`: exact handwritten values, the portal submission a correct registration makes, and the expected `Understanding` |
| `inbound/acme-supplier-invitation.pdf` (English), `inbound/globex-supplier-invitation.pdf` (Portuguese) | Letters from the buyers' procurement teams asking Tidewater Cloud to register in the supplier portal by a deadline, with the invite URL, a reference number and the documents to prepare. Flow 3 input. | `*.expected.json`: buyer, tenant, invite code, portal URL, deadline, reference, documents, expected `Understanding` |
| `voice/scripts.md` | Three short code-switched Portuguese/English voice-note scripts (register a deal, ask for a quote, a registration with the seat count missing) with the expected `Understanding` for each. | `voice/expected.json` (same data, machine-readable) |
| `teach/caravela-register-deal.mp4` | About 45 s, 1280×800 H.264 screen recording of registering a deal (Padaria Estrela, a different deal from the referral photos) on Caravela Partner Hub v1, with a visible cursor. Teach input. | `teach/caravela-register-deal.expected.json`: the `SkillDraft` a good teach model should infer, plus grading hints (accepted param aliases, commit step, success check) |

The voice notes themselves are not generated. Record them from `voice/scripts.md` with consenting speakers and save them as `voice/<id>.ogg`.

## How they are made

- `tsx scripts/make-fixtures.ts` writes everything above except the mp4. It renders HTML with Playwright (PDF for the documents, PNG then a composited "photo" scene for the referral forms), pins the PDF timestamps and seeds all handwriting jitter, so output is byte-identical between runs; files are rewritten only when their bytes change. `--only profile,rep,docs,referrals,invitations,voice,teach` limits the run. All values live in `scripts/lib/data.ts`.
- `tsx scripts/record-teach-video.ts` starts the partner portal on a free port, signs in through the test-session helper, types the registration at human pace with Playwright `recordVideo`, checks the portal stored exactly the intended values, and converts the webm to mp4 (H.264, yuv420p, faststart) with ffmpeg (`FFMPEG_PATH` or `ffmpeg` on PATH). The recording depends on real timing, so it is not byte-deterministic. The close date it types (12/03/2027) must stay in the future.

## Conventions in the ground truth

- Dates in `understanding` and portal submissions are ISO `YYYY-MM-DD`, resolved against 2026-10-27 in America/Sao_Paulo. `asWritten` keeps what is literally on the page (`29/01/2027`, `R$ 90.000,00`, `Brasil`).
- `summaryForRep` and `notes` are free text and are not graded.
- The referral forms state the estimated value in BRL; the partner portal's field is USD. The expected portal submission leaves `estimatedValue` out because it depends on an exchange-rate policy.

## Why the identifiers are safe

- Emails use reserved domains (`example.com`, `*.example`).
- Tax ID `00-1234567`: the IRS never issues EINs with the prefix 00.
- Routing number `999999999` fails the ABA checksum; account `000123456`; SWIFT `EXMPBRS0` has the test-BIC marker (second location character `0`); bank "Banco Exemplo S.A.".
- Policy and certificate numbers start with `SAMPLE-`.
- Phone numbers follow the demo pattern `+55 <area> 99999-0xxx`. Brazil has no reserved fictional range, so treat them as placeholders: nothing in Dockhand dials or messages them.
- Logos are simple shapes drawn for these fictional companies.
