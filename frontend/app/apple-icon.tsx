import { ImageResponse } from "next/og";

// PNG app icon (apple-touch-icon) for link-preview crawlers that ignore the SVG
// favicon. Matches app/icon.svg — a terminal prompt on a dark tile.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111111",
        }}
      >
        <svg width="132" height="132" viewBox="0 0 32 32">
          <polyline
            points="9,11 15,16 9,21"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line x1="17" y1="21.5" x2="24" y2="21.5" stroke="#4a90ff" strokeWidth={2.6} strokeLinecap="round" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
