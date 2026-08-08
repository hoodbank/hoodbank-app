import { Instrument_Serif, Inter } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

// Self-hosted at build time by next/font, so font-src 'self' in the CSP holds.
const serif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-serif",
});
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });

const SITE = "https://wallet.hoodbank.org";
const TITLE = "HoodBank — pay anything on Robinhood Chain";
const DESC =
  "Wallet, swaps, and Visa cards on Robinhood Chain. Hold ETH and USDG, swap across 7 chains, and spend anywhere Visa is accepted.";

// Icons and the link thumbnail come from files Next picks up by convention:
// app/icon.png (favicon), app/apple-icon.png, app/opengraph-image.png and
// app/twitter-image.png — it emits the tags and the size hints itself.
// metadataBase is what makes those URLs absolute, which link scrapers require.
export const metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · HoodBank" },
  description: DESC,
  applicationName: "HoodBank",
  openGraph: {
    type: "website",
    siteName: "HoodBank",
    title: TITLE,
    description: DESC,
    url: SITE,
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
};

// themeColor lives here, not in metadata — deprecated there since Next 14.
export const viewport = {
  themeColor: "#ccff00",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
