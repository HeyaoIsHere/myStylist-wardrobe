"use client";

import { useEffect, useRef, useState } from "react";
import { cutoutCanvas, cutoutToWhite } from "@/lib/client/cutout";

interface CutoutImageProps {
  src: string;
  alt?: string;
  className?: string;
}

/** The subject cut out and presented on a pure white background. */
export function CutoutImage({ src, alt = "", className = "" }: CutoutImageProps) {
  const [result, setResult] = useState<{ src: string; dataUrl: string } | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // Storage URLs are already transparent cutouts — no canvas processing.
    // No state reset here: what to show is derived from `src` at render time
    // below, so switching between srcs needs no synchronous setState at all.
    if (src.startsWith("http")) return;
    const id = ++requestRef.current;
    let alive = true;
    cutoutCanvas(src, 640)
      .then((cut) => {
        if (alive && id === requestRef.current) setResult({ src, dataUrl: cutoutToWhite(cut) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src]);

  const isRemote = src.startsWith("http");
  const currentCutout = result?.src === src ? result.dataUrl : null;
  if (!currentCutout || isRemote) {
    return <img src={src} alt={alt} className={className} loading="lazy" />;
  }
  return <img src={currentCutout} alt={alt} className={className} />;
}
