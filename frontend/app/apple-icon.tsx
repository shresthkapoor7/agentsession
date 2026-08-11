import { ImageResponse } from "next/og";

// PNG app icon (apple-touch-icon) for link-preview crawlers that ignore the SVG
// favicon. Matches app/icon.svg — a session "pulse" on a dark tile.
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
            points="5,17 11,17 14,10 18,24 21,17 27,17"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="27" cy="17" r="1.9" fill="#4a90ff" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
