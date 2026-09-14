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
  const [result, setResult] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    // Storage URLs are already transparent cutouts — no canvas processing
    if (src.startsWith("http")) {
      setResult(null);
      return;
    }
    const id = ++requestRef.current;
    let alive = true;
    cutoutCanvas(src, 640)
      .then((cut) => {
        if (alive && id === requestRef.current) setResult(cutoutToWhite(cut));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src]);

  if (!result) {
    // eslint-disable-next-line @next/next/no-img-element -- pre-cutout preview
    return <img src={src} alt={alt} className={className} loading="lazy" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- canvas-composed data URL
  return <img src={result} alt={alt} className={className} />;
}
