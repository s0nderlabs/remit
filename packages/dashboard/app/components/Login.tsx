"use client";

// The sign-in screen · "The Counter" (login round 3, elpabl0's pick).
// Split title card: the type column toward the center; the REAL dashboard
// card (Visa face) resting tilted on the right; the silk spectrum grown into
// page weather: blurred beams flowing in from the right edge, alive on
// compositor-only transforms, dead just past the wordmark. The card's woven
// guilloche flows only under the pointer (the dashboard grammar) · the beam
// is the page's always-moving layer. The Boot overlay exits over this.

import { useState } from "react";
import { ChipDots, Guilloche } from "./ui";
import s from "./login.module.css";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <main className={s.stage} data-testid="login-screen">
      <div className={s.aurora} aria-hidden>
        <i className={s.beamA} />
        <i className={s.beamB} />
        <i className={s.beamC} />
      </div>

      <section className={s.type}>
        <h1 className={`rv ${s.wm}`} style={{ animationDelay: ".05s" }}>
          remit
        </h1>
        <p className={`rv ${s.tag}`} style={{ animationDelay: ".13s" }}>
          Authority, lent not given.
        </p>
        <p className={`rv ${s.lede}`} style={{ animationDelay: ".21s" }}>
          Scoped, revocable spending cards for your agents · they borrow authority, never hold funds, and die on
          revoke.
        </p>
        <p className={`rv ${s.quiet}`} style={{ animationDelay: ".27s" }}>
          Sign in with email or Google · no seed phrase
        </p>
        <span className={`rv ${s.ctarow}`} style={{ animationDelay: ".36s" }}>
          <button className={`primary ${s.cta}`} onClick={onLogin} data-testid="login">
            Sign In
          </button>
        </span>
      </section>

      <section className={s.counter} aria-hidden>
        <div className={`rv ${s.frame}`} style={{ animationDelay: ".3s" }}>
          <div className={s.tilt} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <div className={`card ${s.cardobj}`}>
              <div className="band">
                <Guilloche width={472} height={88} animate={hover} />
              </div>
              <div className="inner">
                <div className="row1">
                  <span className="wm">remit</span>
                </div>
                <ChipDots />
                <div className="num">
                  <span>4000</span>
                  <span>0099</span>
                  <span>9000</span>
                  <span>0013</span>
                  <span className="brandmark">Visa</span>
                </div>
                <div className="holderline">
                  <span className="hname">Agent Card</span>
                  <span className="hexp">04/29</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
