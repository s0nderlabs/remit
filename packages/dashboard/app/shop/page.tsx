"use client";

// /shop: standalone demo merchant ("s0nder supply co."). Deliberately NOT
// remit-branded: it plays a generic online store in the demo video. An agent
// fills the checkout form via browser automation (data-testids below), the
// fiat lane authorizes behind the scenes. No Privy, no dashboard chrome -
// plain fetch against the server's public /shop routes.

import { useEffect, useState } from "react";
import { shopApiBase } from "./api-base";
import s from "./shop.module.css";

const BASE = shopApiBase(process.env.NEXT_PUBLIC_REMIT_API);

type Product = { id: string; name: string; price: string };
type Catalog = { merchant: string; products: Product[] };
type CheckoutResult = {
  approved: boolean;
  reason: string;
  authorization_id?: string;
  product?: Product;
  last4?: string;
};

export default function ShopPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [picked, setPicked] = useState<Product | null>(null);
  const [number, setNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/shop/products`, { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        setCatalog((await res.json()) as Catalog);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // keep the browser tab in character (root layout titles the remit dashboard)
  useEffect(() => {
    document.title = catalog?.merchant ?? "s0nder supply co.";
  }, [catalog]);

  const pick = (p: Product) => {
    setPicked(p);
    setResult(null);
    setPayErr(null);
  };

  const pay = async () => {
    if (!picked) return;
    setPaying(true);
    setPayErr(null);
    try {
      const res = await fetch(`${BASE}/shop/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_id: picked.id,
          card: { number, exp_month: Number(expMonth), exp_year: Number(expYear), cvc },
        }),
      });
      // declines come back 200 { approved: false }; only malformed/disabled are non-2xx
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.reason ?? body?.error ?? `http ${res.status}`);
      setResult(body as CheckoutResult);
    } catch (e) {
      setPayErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  };

  const tryAgain = () => {
    setResult(null);
    setPayErr(null);
  };

  const formReady = number.trim() !== "" && expMonth.trim() !== "" && expYear.trim() !== "" && cvc.trim() !== "";

  return (
    <div className={s.wrap}>
      <div className={s.inner}>
        <div className={s.brand}>{catalog?.merchant ?? "s0nder supply co."}</div>
        <div className={s.tag}>everyday goods, shipped fast.</div>

        {loadErr && <p className={s.quiet}>store is unavailable right now ({loadErr}). refresh to retry.</p>}
        {!loadErr && !catalog && <p className={s.quiet}>loading…</p>}

        {catalog && (
          <div className={s.grid}>
            {catalog.products.map((p) => (
              <div key={p.id} className={s.product}>
                <div className={s.pname}>{p.name}</div>
                <div className={s.pprice}>${p.price}</div>
                <button
                  className={picked?.id === p.id ? `${s.buy} ${s.active}` : s.buy}
                  onClick={() => pick(p)}
                  data-testid={`buy-${p.id}`}
                >
                  buy
                </button>
              </div>
            ))}
          </div>
        )}

        {picked && (
          <div className={s.panel}>
            <div className={s.ptitle}>
              checkout · {picked.name} · ${picked.price}
            </div>

            {result === null ? (
              <>
                <div className={s.fields}>
                  <label className={s.field}>
                    card number
                    <input
                      value={number}
                      onChange={(e) => setNumber(e.target.value)}
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="4242 4242 4242 4242"
                      data-testid="number"
                    />
                  </label>
                  <div className={s.exprow}>
                    <label className={s.field}>
                      exp month
                      <input
                        value={expMonth}
                        onChange={(e) => setExpMonth(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-exp-month"
                        placeholder="12"
                        data-testid="exp-month"
                      />
                    </label>
                    <label className={s.field}>
                      exp year
                      <input
                        value={expYear}
                        onChange={(e) => setExpYear(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-exp-year"
                        placeholder="2030"
                        data-testid="exp-year"
                      />
                    </label>
                    <label className={s.field}>
                      cvc
                      <input
                        value={cvc}
                        onChange={(e) => setCvc(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        placeholder="123"
                        data-testid="cvc"
                      />
                    </label>
                  </div>
                </div>
                <div className={s.payrow}>
                  <button className={s.pay} onClick={pay} disabled={!formReady || paying} data-testid="pay">
                    {paying ? "paying…" : `pay $${picked.price}`}
                  </button>
                </div>
                {payErr && (
                  <div className={`${s.result} ${s.declined}`} data-testid="result">
                    something went wrong · {payErr}
                  </div>
                )}
              </>
            ) : result.approved ? (
              <>
                <div className={`${s.result} ${s.approved}`} data-testid="result">
                  payment approved · {result.product?.name ?? picked.name}
                  {result.last4 && <> · card ending {result.last4}</>}
                  {result.authorization_id && (
                    <span className={s.authid}>authorization {result.authorization_id}</span>
                  )}
                </div>
                <div className={s.payrow}>
                  <button className={s.again} onClick={tryAgain} data-testid="try-again">
                    buy something else
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={`${s.result} ${s.declined}`} data-testid="result">
                  payment declined · {result.reason}
                </div>
                <div className={s.payrow}>
                  <button className={s.again} onClick={tryAgain} data-testid="try-again">
                    try again
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
