import { useEffect, useId, useRef, useState } from "react";
import { uiText } from "../locales";

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        fontFamily: '"Noto Sans JP", Inter, system-ui, sans-serif',
        themeVariables: {
          primaryColor: "#e0eeff",
          primaryTextColor: "#17233a",
          primaryBorderColor: "#76a9df",
          lineColor: "#597491",
          secondaryColor: "#eef7ff",
          tertiaryColor: "#fbfdff",
        },
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const renderVersion = useRef(0);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setError("");
    const renderId = `${diagramId}-${++renderVersion.current}`;
    void (async () => {
      try {
        if (document.fonts) await document.fonts.ready;
        const mermaid = await loadMermaid();
        const rendered = await mermaid.render(renderId, chart);
        if (!cancelled) setSvg(rendered.svg);
      } catch {
        if (!cancelled) setError(uiText.mermaid.syntaxError);
      }
    })();
    return () => { cancelled = true; };
  }, [chart, diagramId]);

  if (error) return <div className="mermaid-error" role="alert">{error}</div>;
  if (!svg) return <div className="mermaid-loading" role="status">{uiText.mermaid.loading}</div>;
  return <div className="mermaid-diagram" role="img" aria-label={uiText.mermaid.diagramLabel} dangerouslySetInnerHTML={{ __html: svg }} />;
}
