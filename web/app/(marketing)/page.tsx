// Placeholder only. The real homepage (seven feature families, timer/rooms/
// coaching/proof visually dominant — docs/architecture/api.md §homepage,
// docs/designs/mtdo-web-v1-plan.md) goes through the per-wave design-canvas
// step before it's built here. This page exists so the scaffold is
// verifiable end to end.
export default function MarketingHomePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "var(--space-md)",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: "-0.035em" }}>
        mtdo
      </h1>
      <p style={{ color: "var(--muted)", fontWeight: 300 }}>
        Scaffold is live. Real homepage pending its design-canvas pass.
      </p>
    </main>
  );
}
