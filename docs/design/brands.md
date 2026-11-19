# Brands

Built Nov 17, 2026. Some customers are large companies made of smaller ones, their **brands**. For example, Globex has the brands Lumen and Bolt.

## The model: a brand is a customer

A brand is a customer like any other, with one extra fact: the customer it belongs to, its **company**. So everything a customer has, a brand has too, with no new kinds of links or keys:
- its own settings on every flag,
- its own app link and file,
- API keys,
- its own page,
- Compare, approvals and History.

- **Follows its company by default.** On a flag where a brand has no settings of its own, it gets what its company gets: the company's rules, then the rules for everyone and the defaults.
- **Its own settings come first.** A brand chooses how it follows its company, using the same three choices a customer has today:

  | Choice | What the brand gets |
  |---|---|
  | **Rules only** | The brand's rules first. If none match, everything its company gets. |
  | **Rules + own default** | The brand's rules, then its company's rules and the rules for everyone, then the brand's own default. |
  | **Customer only** | Only the brand's rules and default. Its company's settings and the rules for everyone are skipped. |

- **Overrides for everyone still win**, for brands too.
- **One level only.** A brand's company can't itself be a brand, and a customer with brands can't become one. The database enforces this (migration `0003_brands.sql`).
- **Targeting:**
  - "Customer is Lumen" (`customer.id`) matches only Lumen, as for any customer.
  - The new attribute **"Company is Globex"** (`customer.company`) matches Globex and all its brands. It can also be used for a % split by company. For a customer that isn't a brand, its company is itself.

### The order a request is decided in

```
1. Flag off                        → the app's in-app default
2. Overrides for everyone          (locked rules)
3. The customer's own rules        ┐ "Customer only" stops here with its own default
4. For a brand: its company's rules ┐ the company's "Customer only" stops here
5. Rules for everyone
6. Default: the most specific one that has its own (the brand, then its company, then everyone)
```

## Where it lives

| Part | Change |
|---|---|
| `server/migrations/0003_brands.sql` | `customer.parent_id`, plus the one-level rule as a trigger |
| `server/evaluator.ts` | `CustomerInfo.company`. `customerChain()` is the order above, written once; `evaluate()` and `forCustomer()` walk it. New sections `company_rule` / `company_default` say when the company decided. |
| `server/snapshot.ts` | Customers load with their company |
| `server/control.ts`, `server/api.ts` | Create or edit a customer with `company`. The customer list puts brands right under their company, and searching a company finds its brands. A customer's page data includes its company and brands. |
| `server/fields.ts`, `server/words.ts` | The `customer.company` attribute, and the wording "Globex’s rule" / "Globex’s default" |
| Console | **Brand of** when adding or editing a customer. The list shows "brand of Globex" and "2 brands". A brand's page links its company, and a company's page lists its brands. Brands show as "Lumen (Globex)" on flags, in Compare and in Approvals. **Try it** follows the company. |

### Working with brands in the console

- **Where each value comes from** (Google Workspace Admin's "inherited / overridden"):
  - On a brand's page every flag says **Own settings** or **From Globex**.
  - **Use Globex’s again** removes the brand's own settings, for one flag (in its panel) or for the selected flags.
  - It's one change; where the environment needs approval it becomes a request with a reason.
- **Brands side by side** (Salesforce's account hierarchy): a company's **Brands** tab (`#/customer/<company>/<env>/brands`) shows a grid of flags × the company and each brand.
  - A brand's cell is shaded where it gets something other than its company, and marked **Own** where it has settings of its own.
  - **Only where a brand differs** filters to those flags. Data: `GET /api/customers/:key/brands`.
- **Why it gets this** (Azure's "effective access"): a flag's panel on a customer's page lists the levels of its customer chain, and which one decided:
  - overrides for everyone, where the flag has any,
  - the customer's own settings,
  - for a brand, its company's,
  - everyone's.

  Each level says whether it's set, whether it's skipped (and whose "Customer only" skips it), and links to where it's edited. Data: `levels` on each row of `GET /api/customers/:key/flags`, read from `customerChain()`.

Delivery is unchanged. A brand's app reads its own link, and its file is built with the brand's and its company's settings worked out on the server, so nothing about other customers reaches the device.

## Tests (`test/brands.test.ts`)

- **Every combination:**
  - the brand has no settings, or any of the three choices, against the same four cases for its company;
  - five kinds of request each: an override, the brand's rule, the company's rule, the rule for everyone, and none.

  Each answer is checked against the order above, in both the evaluator and the brand's app file. The company and its other brand are checked to be unaffected.
- **Other checks:**
  - which settings decided the answer, as shown on the customer page;
  - "Company is …" against "Customer is …";
  - brand links;
  - the one-level rule;
  - the list order.

## Not built (later, if needed)

- **Customer overrides:** a company locking a rule so its brands can't change it. Today only overrides for everyone are locked.
- **Replacing all of a company's app links at once.** Each brand's link is replaced on its own, like any customer's.
