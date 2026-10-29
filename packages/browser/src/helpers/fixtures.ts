// HTML fixtures for the helper tests (synthetic data only).

export const REGISTER_FORM = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  form { padding: 24px; width: 600px; }
  .req::after { content: " *"; color: red; }
  .row { margin: 8px 0; }
  [role=listbox] { position: absolute; top: 120px; left: 700px; background: #fff; border: 1px solid #ccc;
    list-style: none; padding: 0; margin: 0; width: 200px; }
  [role=option] { padding: 6px; cursor: pointer; }
  .clicky { cursor: pointer; padding: 8px; background: #eee; width: 160px; }
  .hidden-dup { display: none; }
</style></head><body>
<form id="register" aria-label="Register a deal" onsubmit="event.preventDefault(); fetch('/api/register', { method: 'POST', body: 'x' })">
  <h2>Register a deal</h2>
  <fieldset><legend>Company</legend>
    <div class="row"><label for=":r1:" class="req">Company name</label> <input id=":r1:" name="company" data-testid="company"></div>
    <div class="row"><label for=":r2:">Website</label> <input id=":r2:" placeholder="acme.example" data-testid="website"></div>
    <div class="row"><label id="country-lbl" for="country-input">Country</label>
      <input id="country-input" role="combobox" aria-expanded="true" aria-controls="country-list" autocomplete="off"></div>
  </fieldset>
  <fieldset><legend>Primary contact</legend>
    <div class="row"><label for=":r4:">Email</label> <input id=":r4:" type="email"></div>
  </fieldset>
  <fieldset><legend>Billing contact</legend>
    <div class="row"><label for=":r6:">Email</label> <input id=":r6:" type="email"></div>
  </fieldset>
  <div class="row"><label class="chk"><input type="checkbox" name="consent"> <span>I confirm the customer consented</span></label></div>
  <div class="row"><label for="w9" class="req">W-9 form</label> <input id="w9" type="file" name="w9"></div>
  <fieldset id="tier"><legend>Partner tier</legend>
    <label><input type="radio" name="tier" value="gold"> Gold</label>
    <label><input type="radio" name="tier" value="silver"> Silver</label>
  </fieldset>
  <div class="row"><div class="clicky" id="adv"><span>Advanced options</span></div></div>
  <div class="row">
    <button type="submit" class="btn" data-testid="submit-reg"><svg width="16" height="16"><rect width="16" height="16" fill="green"/></svg><span>Submit registration</span></button>
    <button type="button" class="btn hidden-dup" data-testid="submit-reg">Submit registration</button>
  </div>
</form>
<ul id="country-list" role="listbox" aria-labelledby="country-lbl">
  <li role="option" id="opt-br">Brazil</li>
  <li role="option" id="opt-mx">Mexico</li>
</ul>
</body></html>`;
