// Zoom and pan for the image lightbox. Node-free: the view is a scale plus a
// translation of the fitted image, both in screen pixels, and every gesture
// (wheel, pinch, double-click, drag) is a function from one view to the next.

export interface ZoomView {
	scale: number;
	x: number;
	y: number;
}

const MIN_SCALE = 1;
export const MAX_SCALE = 8;
// The scale a double-click or double-tap jumps to from the fitted view.
export const STEP_SCALE = 2.5;

export const FITTED: ZoomView = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Keep the image covering the stage: at a given scale the image may slide no
// further than half its overflow in each direction, and is centred when smaller.
export function clampView(view: ZoomView, stage: { w: number; h: number }, image: { w: number; h: number }): ZoomView {
	const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
	const limitX = Math.max(0, (image.w * scale - stage.w) / 2);
	const limitY = Math.max(0, (image.h * scale - stage.h) / 2);
	// + 0 turns a -0 from clamping 0 into a plain 0.
	return { scale, x: clamp(view.x, -limitX, limitX) + 0, y: clamp(view.y, -limitY, limitY) + 0 };
}

// Scale by `factor` keeping the point under (px, py) still. The point is given
// relative to the stage centre, which is where the fitted image is centred.
export function zoomAt(view: ZoomView, factor: number, px: number, py: number): ZoomView {
	const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
	const k = scale / view.scale;
	return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

// A wheel notch zooms by about 10%; trackpad pinches arrive as small deltas
// with ctrlKey set and are scaled the same way, so both feel continuous.
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.exp(-clamp(px, -100, 100) / 500);
}

// Double-click / double-tap: zoom in to STEP_SCALE at the point, or back to fit.
export function toggleZoom(view: ZoomView, px: number, py: number): ZoomView {
	return view.scale > MIN_SCALE ? FITTED : zoomAt(view, STEP_SCALE, px, py);
}
