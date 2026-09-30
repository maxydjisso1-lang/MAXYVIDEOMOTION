import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { BrandVideo } from "./BrandVideo.js";
import type { BrandVideoProps } from "./props.js";

const calculateMetadata: CalculateMetadataFunction<BrandVideoProps> = ({ props }) => ({
  durationInFrames: props.durationInFrames,
  fps: props.fps,
  width: props.width,
  height: props.height,
});

export function RemotionRoot() {
  return (
    <Composition
      id="BrandVideo"
      component={BrandVideo}
      calculateMetadata={calculateMetadata}
      durationInFrames={30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{} as BrandVideoProps}
    />
  );
}
