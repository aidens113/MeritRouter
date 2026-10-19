export const THEME_KEY = "sy-theme";

/** Inline script run before paint so a stored light/dark choice applies without a flash. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
