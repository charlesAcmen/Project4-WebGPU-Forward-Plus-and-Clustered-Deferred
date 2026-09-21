/** Shared responsive dimensions for dat.GUI, Stats, and future performance UI. */
export function installOverlayLayout(gui: { width: number }): void {
    const root = document.documentElement;

    const update = () => {
        const viewport = window.visualViewport;
        //left ?? right: nullish coalescing operator(空值合并), 
        //returns the right-hand side operand when the left-hand side operand is null or undefined, otherwise returns the left-hand side operand.
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

        const controlWidth = touch
            ? Math.min(Math.max(width - 24, 260), 400)
            : Math.min(Math.max(width * 0.18, 260), 320);
        const rowHeight = touch
            ? Math.min(Math.max(height * 0.065, 40), 48)
            : 34;
        const fontSize = touch
            ? Math.min(Math.max(width * 0.042, 15), 17)
            : 14;
        const statsScale = touch ? Math.min(Math.max(width / 420, 1), 1.2) : 1;

        root.style.setProperty('--overlay-control-width', `${Math.round(controlWidth)}px`);
        root.style.setProperty('--overlay-row-height', `${Math.round(rowHeight)}px`);
        root.style.setProperty('--overlay-font-size', `${Math.round(fontSize)}px`);
        root.style.setProperty('--overlay-stats-scale', statsScale.toFixed(2));
        gui.width = Math.round(controlWidth);
    };

    update();
    //passive:true means the event listener will never call preventDefault(), which allows the browser to optimize scrolling performance.
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('orientationchange', update, { passive: true });
    //?.:optional chaining
    //equivalent to if(window.visualViewport) { window.visualViewport.addEventListener('resize', update, { passive: true }); }
    window.visualViewport?.addEventListener('resize', update, { passive: true });
}
