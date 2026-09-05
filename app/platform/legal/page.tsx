import Link from "next/link";
import type { Metadata } from "next";
import { LEGAL_DOCS } from "@/lib/legal/documents";
import { PLATFORM_URL } from "@/lib/site";
import styles from "./legal.module.css";

export const metadata: Metadata = {
  title: "Policies · StoreMink",
  description:
    "The terms, privacy policy and acceptable use policy for StoreMink.",
  alternates: { canonical: `${PLATFORM_URL}/legal` },
};

// The index. Every policy in one place, so the consent sentence at signup can
// link somewhere that shows the whole set rather than one document in isolation.
export default function LegalIndexPage() {
  return (
    <div className={styles.page}>
      <div className={styles.doc}>
        <h1 className={styles.title}>Legal Policies</h1>
        <p className={styles.lede}>
          The agreements that govern StoreMink. Each is versioned — the version
          you agreed to is the one that binds you, and it stays available.
        </p>

        <ul className={styles.list}>
          {LEGAL_DOCS.map((doc) => (
            <li key={doc.kind}>
              <Link href={`/legal/${doc.slug}`} className={styles.card}>
                <span className={styles.cardTitle}>{doc.title}</span>
                <span className={styles.cardSummary}>{doc.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
