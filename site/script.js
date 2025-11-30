document.addEventListener("DOMContentLoaded", () => {
  const sidebarLinks = document.querySelectorAll("#sidebar a");

  // サイドバークリックでメインコンテンツ切り替え（ホームページ内用）
  sidebarLinks.forEach(link => {
    link.addEventListener("click", e => {
      // 外部ページに飛ぶ場合は通常リンクでOK
      if (link.getAttribute("href").endsWith(".html") && link.getAttribute("href") !== "index.html") {
        return; // そのまま遷移
      }

      e.preventDefault();
      const targetId = link.getAttribute("href").substring(1); // #sectionId
      const sections = document.querySelectorAll("#content section");

      sections.forEach(sec => {
        sec.style.display = sec.id === targetId ? "block" : "none";
      });
    });
  });

  // 最初は最初のセクションだけ表示（ホームページ内用）
  const sections = document.querySelectorAll("#content section");
  sections.forEach((sec, i) => sec.style.display = i === 0 ? "block" : "none");
});
