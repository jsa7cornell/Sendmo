import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "@/App";

describe("App Routing", () => {
    it("renders the home page on /", () => {
        window.history.pushState({}, "Test page", "/");
        render(<App />);
        expect(screen.getByText("Prepaid shipping made easy")).toBeInTheDocument();
    });

    it("renders the FAQ page on /faq", () => {
        window.history.pushState({}, "Test page", "/faq");
        render(<App />);
        expect(screen.getByText("FAQ")).toBeInTheDocument();
    });

    it("renders the Dashboard on /dashboard", () => {
        window.history.pushState({}, "Test page", "/dashboard");
        render(<App />);
        expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });

    it("renders the Onboarding on /onboarding", () => {
        window.history.pushState({}, "Test page", "/onboarding");
        render(<App />);
        expect(screen.getByText("How would you like to ship?")).toBeInTheDocument();
    });

    it("renders Not Found on unknown paths", () => {
        window.history.pushState({}, "Test page", "/this-does-not-exist");
        render(<App />);
        expect(screen.getByText("NotFound")).toBeInTheDocument();
    });
});
