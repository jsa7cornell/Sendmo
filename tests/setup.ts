import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock matchMedia for Radix UI components
Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
});

// Mock PointerEvent for Radix UI components
if (typeof window.PointerEvent === 'undefined') {
    class PointerEvent extends MouseEvent {
        pointerId: number;
        width: number;
        height: number;
        pressure: number;
        tiltX: number;
        tiltY: number;
        pointerType: string;
        isPrimary: boolean;

        constructor(type: string, params: PointerEventInit = {}) {
            super(type, params);
            this.pointerId = params.pointerId || 0;
            this.width = params.width || 0;
            this.height = params.height || 0;
            this.pressure = params.pressure || 0;
            this.tiltX = params.tiltX || 0;
            this.tiltY = params.tiltY || 0;
            this.pointerType = params.pointerType || '';
            this.isPrimary = params.isPrimary || false;
        }
    }
    (window as any).PointerEvent = PointerEvent;
}
