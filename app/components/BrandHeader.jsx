import { useRouteLoaderData } from "react-router";
import seosLogo from "../assets/SEoS.png";
import { appNames } from "../lib/app-brand.js";

// Shared internal-page header — matches the brand row on the redesigned
// home page (logo mark, wordmark, page name) with the green gradient
// hairline underneath. Internal pages render this in place of the old
// bare gradient div; page contents below it are unchanged.
//
// `gutter` controls the bottom margin: pages whose parent layout already
// supplies spacing (a BlockStack gap) pass gutter={false}.
export default function BrandHeader({ title, gutter = true }) {
  // What the app is called — "AVA" on the Aetrex app (app.jsx's loader).
  const name = appNames(useRouteLoaderData("routes/app")?.appName).short;
  return (
    <div style={{ marginBottom: gutter ? "20px" : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", paddingBottom: "12px" }}>
        <img
          src={seosLogo}
          alt=""
          style={{ display: "block", height: "26px", width: "auto" }}
        />
        <span
          style={{
            fontSize: "12px",
            fontWeight: 650,
            letterSpacing: "1.4px",
            textTransform: "uppercase",
            color: "#2D6B4F",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {title ? (
          <span
            style={{
              fontSize: "12px",
              color: "rgba(26,46,38,0.55)",
              borderLeft: "1px solid rgba(45,107,79,0.25)",
              paddingLeft: "10px",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
        ) : null}
      </div>
      <div
        style={{
          height: "3px",
          borderRadius: "2px",
          background: "linear-gradient(90deg, #2D6B4F, #A8326B 58%, rgba(168,50,107,0) 100%)",
        }}
      />
    </div>
  );
}
