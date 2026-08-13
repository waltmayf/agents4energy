import Link from "next/link";
import type { Metadata } from "next";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Agents for Energy",
  description:
    "AI agents for the control room — build them, then put them to work.",
};

/**
 * Root landing page. Signature element is the grid-frequency waveline: a power
 * grid holds ~60 Hz, and its steadiness is the whole job of an operator. The
 * amber trace is the one place we spend color; everything else stays ink on a
 * warm canvas, quiet enough to let the two doors — console and builder — read
 * clearly.
 */
export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.grain} aria-hidden="true" />

      <div className={styles.frame}>
        <header className={styles.masthead}>
          <span className={styles.wordmark}>Agents&nbsp;for&nbsp;Energy</span>
          <span className={styles.readout} aria-hidden="true">
            <span className={styles.readoutDot} />
            60.00&nbsp;Hz
          </span>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>Operations intelligence</p>
          <h1 className={styles.headline}>
            Bring AI agents
            <br />
            to the control room.
          </h1>
          <p className={styles.lede}>
            Design agents against your own tools and data, then hand them the
            work — monitoring, analysis, and the routine calls that keep the
            grid steady.
          </p>

          <div className={styles.actions}>
            <Link href="/chat" className={styles.primary}>
              Open the console
              <span aria-hidden="true" className={styles.arrow}>
                →
              </span>
            </Link>
            <Link href="/agents" className={styles.secondary}>
              Agent Builder
              <span aria-hidden="true" className={styles.arrow}>
                →
              </span>
            </Link>
          </div>
        </section>

        {/* The waveline — a live 60 Hz trace, the heartbeat of the grid. */}
        <div className={styles.wave} aria-hidden="true">
          <svg
            viewBox="0 0 1200 200"
            preserveAspectRatio="none"
            className={styles.waveSvg}
          >
            <path
              className={styles.waveBack}
              d="M0 100 C 60 40, 120 40, 180 100 S 300 160, 360 100 S 480 40, 540 100 S 660 160, 720 100 S 840 40, 900 100 S 1020 160, 1080 100 S 1200 40, 1260 100"
            />
            <path
              className={styles.waveFront}
              d="M0 100 C 60 40, 120 40, 180 100 S 300 160, 360 100 S 480 40, 540 100 S 660 160, 720 100 S 840 40, 900 100 S 1020 160, 1080 100 S 1200 40, 1260 100"
            />
          </svg>
        </div>

        <footer className={styles.footer}>
          <span>Two doors in.</span>
          <span className={styles.footerLinks}>
            <Link href="/chat" className={styles.footerLink}>
              Console
            </Link>
            <span className={styles.footerSep}>/</span>
            <Link href="/agents" className={styles.footerLink}>
              Builder
            </Link>
            <span className={styles.footerSep}>/</span>
            <Link href="/graph" className={styles.footerLink}>
              Graph
            </Link>
            <span className={styles.footerSep}>/</span>
            <Link href="/files" className={styles.footerLink}>
              Files
            </Link>
          </span>
        </footer>
      </div>
    </main>
  );
}
