"use client";

// ---------------------------------------------------------------------------
// "You're ₹200 away from free delivery" — `docs/offers-plan.md` §14b.
//
// ★ THE GAP COMES FROM THE ENGINE, NEVER COMPUTED HERE. This is a claim about
// what happens if the shopper adds something, and only the engine knows the
// answer: under best-offer-wins, whether an offer would actually apply depends
// on what it is competing with. A component that computed
// `threshold − subtotal` itself would promise an offer the engine then declines
// because another one scored higher — on precisely the carts where a shopper is
// paying attention.
//
// ★ AND THE SERVER DECIDES WHAT IS NUDGEABLE. A code-delivery or
// group-restricted offer is filtered out in `collectNearMiss`, because nudging
// "₹200 from 20% off with WHOLESALE20" leaks a targeted code to every visitor
// and defeats the restriction that was deliberately set. This component renders
// what it is given; it must never widen that.
// ---------------------------------------------------------------------------

import type { NearMissOffer } from "@/lib/offers/apply";

const inr = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** What the shopper would get. Deliberately not the offer's internal name,
 *  which is the merchant's reference ("Launch week Q3") and means nothing to a
 *  customer. */
function rewardPhrase(offer: NearMissOffer): string {
  // ★ THE MAIN USE OF THIS NUDGE (plan §14b). "Add ₹200 more to get a
  // discount" is what the generic fallback would say for a free-delivery
  // offer, and it is the one reward where naming it is the entire persuasion.
  if (offer.rewardType === "free_shipping") return "free delivery";
  if (offer.amount && !offer.percent) return `${inr(offer.amount)} off`;
  if (offer.percent) return `${offer.percent}% off`;
  return "a discount";
}

/**
 * " instead of 10% off" — appended only when the cart is ALREADY earning from
 * this offer and the gap buys a better level.
 *
 * ★★ WITHOUT THIS THE LADDER NUDGE IS ACTIVELY MISLEADING. "Add ₹200 more to
 * get 15% off" reads, to somebody already receiving 10%, as though they are
 * getting nothing today — so the honest sentence and the wrong one differ by
 * three words. The engine sends `currentPercent`/`currentAmount` precisely so
 * this component never has to infer which situation it is in; absent means the
 * offer does not apply yet, and the plain sentence is then correct.
 */
function insteadOf(offer: NearMissOffer): string {
  if (typeof offer.currentPercent === "number") {
    return ` instead of ${offer.currentPercent}%`;
  }
  if (typeof offer.currentAmount === "number") {
    return ` instead of ${inr(offer.currentAmount)}`;
  }
  return "";
}

/**
 * What completing the set earns, as the object of "…to get ___".
 *
 * ★★ IT READ "Add 1 more and one is free", WHICH IS NOT A SENTENCE ANYONE
 * WRITES. Two clauses joined by "and" made the reward a separate statement of
 * fact ("one is free") rather than the thing the action buys, so the line
 * parsed as two half-thoughts. Phrased as a purpose — "Add 1 more to get one
 * free" — it is the same information in the shape people actually say it.
 */
function setReward(offer: NearMissOffer): string {
  const n = offer.getQuantity ?? 1;
  const noun = n === 1 ? "one" : `${n}`;
  return offer.percent && offer.percent < 100
    ? `${noun} at ${offer.percent}% off`
    : `${noun} free`;
}

export function OfferNudge({
  nearMiss,
  className = "",
}: {
  nearMiss: readonly NearMissOffer[] | null | undefined;
  className?: string;
}) {
  // ★ ONE NUDGE, THE CLOSEST. The engine returns them sorted nearest-first;
  // three "you could save more" banners at once is noise that trains people to
  // read past the strip entirely.
  const offer = nearMiss?.[0];
  if (!offer || offer.gap <= 0) return null;

  // ★ TWO SENTENCES, BECAUSE THE TWO GAPS ARE NOT THE SAME KIND OF THING.
  // "Add ₹200 more" and "add 1 more" cannot share a template — a single one
  // would have to render the unit gap as currency or the spend gap as a count,
  // and either reads as a bug. The engine tags which it is rather than leaving
  // the component to infer it from the number.
  // ★ A QUANTITY LADDER IS A UNIT GAP THAT IS NOT A SET. Both arrive as
  // `kind: "units"`, and "add 2 more and one is free" would be flatly wrong for
  // a case price — so the reward TYPE, which the engine already sends, decides
  // the second half of the sentence.
  const body =
    offer.kind === "units" ? (
      offer.rewardType === "volume_break" ? (
        <>
          Add <strong>{offer.gap}</strong> more to get {rewardPhrase(offer)} on
          each{insteadOf(offer)}
        </>
      ) : (
        <>
          Add <strong>{offer.gap}</strong> more
          {offer.productName ? (
            <>
              {" "}
              <strong>{offer.productName}</strong>
            </>
          ) : null}{" "}
          to get {setReward(offer)}
        </>
      )
    ) : (
      <>
        Add <strong>{inr(offer.gap)}</strong> more to get {rewardPhrase(offer)}
        {insteadOf(offer)}
      </>
    );

  return (
    <p
      className={`sm-offer-nudge ${className}`.trim()}
      // Announced politely: it changes as the cart changes, and a live region
      // that interrupts on every quantity tap is worse than silence.
      aria-live="polite"
    >
      {/* ★ DECORATIVE, AND MARKED AS SUCH. The sentence carries the whole
          message; a screen reader announcing "sparkles" before it adds nothing
          and interrupts a live region that already fires on every cart edit. */}
      <span className="sm-offer-nudge-spark" aria-hidden>
        ✨
      </span>
      <span>{body}</span>
    </p>
  );
}
