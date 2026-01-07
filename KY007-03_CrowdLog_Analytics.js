      (function () {
        // ========================================
        // グローバル変数
        // ========================================
        let appData = {
          records: [],
          months: [],
          departments: [],
          projects: [],
          employees: [],
          savedFilters: [],
        };

        let filters = {
          projects: [],
          departments: [],
          employees: [],
          periodStart: "",
          periodEnd: "",
        };

        let isManHour = true; // デフォルト人日

        let filterSorts = {
          projects: "selected",
          departments: "selected",
          employees: "selected",
        };

        function updateFilterSort(type, value) {
          filterSorts[type] = value;
          updateFiltersUI();
        }

        function getSortedItems(type) {
          let items = [...appData[type]]; // ソース配列をコピー
          const sortType = filterSorts[type];

          if (sortType === "selected") {
            // 選択順: 選択済みアイテムは filters[type] の順序を尊重して先頭に並べ、
            // 未選択は名前順で後に並べる
            const selected = [];
            const remaining = new Set(items);
            // filters[type] にある順で selected に追加（存在する場合のみ）
            filters[type].forEach((v) => {
              if (remaining.has(v)) {
                selected.push(v);
                remaining.delete(v);
              }
            });
            // 残りは名前順にソートして追加
            const rest = Array.from(remaining).sort((a, b) => a.localeCompare(b, "ja"));
            items = selected.concat(rest);
          } else if (sortType === "name_desc") {
            items.sort((a, b) => b.localeCompare(a, "ja"));
          } else {
            items.sort((a, b) => a.localeCompare(b, "ja"));
          }
          return items;
        }

        const STORAGE_KEY = "crowdlog_data";

        // ========================================
        // 初期化
        // ========================================
        document.addEventListener("DOMContentLoaded", () => {
          initDropZone();
          initControlListeners();
          loadFromStorage();
        });

        // ========================================
        // ドロップゾーン
        // ========================================
        function initDropZone() {
          // ファイル入力とカスタムボタン
          const fileInput = document.getElementById("fileInput");
          const btnSelect = document.getElementById("btnSelectFile");
          const dropZone = document.getElementById("dropZone");
          const fileControls = document.getElementById("fileControls");

          if (btnSelect && fileInput) {
            btnSelect.addEventListener("click", () => fileInput.click());
          }

          if (fileInput) {
            fileInput.addEventListener("change", (e) => {
              const file = e.target.files[0];
              if (file) processFile(file);
              setTimeout(alignDropZoneHeight, 50);
            });
          }

          // ドラッグ＆ドロップを復活
          function prevent(e) {
            e.preventDefault();
            e.stopPropagation();
          }

          function alignDropZoneHeight() {
            if (dropZone && fileControls) {
              dropZone.style.height = fileControls.offsetHeight + "px";
            }
          }
          // 外部からも呼べるようにエクスポート
          window.alignDropZoneHeight = alignDropZoneHeight;

          if (dropZone) {
            ["dragenter", "dragover"].forEach((ev) =>
              dropZone.addEventListener(ev, (e) => {
                prevent(e);
                dropZone.classList.add("dragover");
              })
            );

            ["dragleave", "drop"].forEach((ev) =>
              dropZone.addEventListener(ev, (e) => {
                prevent(e);
                dropZone.classList.remove("dragover");
                if (ev === "drop") {
                  const dt = e.dataTransfer;
                  const files = dt && dt.files ? dt.files : null;
                  if (files && files.length) {
                    processFile(files[0]);
                    setTimeout(alignDropZoneHeight, 50);
                  }
                }
              })
            );
          }

          // 初期配置とリサイズ対応
          alignDropZoneHeight();
          window.addEventListener("resize", alignDropZoneHeight);
        }

        // ========================================
        // ファイル処理
        // ========================================
        function processFile(file) {
          if (!file.name.endsWith(".csv")) {
            showToast("CSVファイルを選択してください", true);
            return;
          }

          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              const arrayBuffer = e.target.result;
              const pref = 'auto';
              const decoded = decodeArrayBufferToText(arrayBuffer, pref);
              console.log('file encoding used:', decoded.encoding);
              const text = decoded.text;
              parseCSV(text);
              // CSV読み込み直後はデフォルトで「選択順」を使用する
              filterSorts.projects = 'selected';
              filterSorts.departments = 'selected';
              filterSorts.employees = 'selected';
              // 永続化
              try {
                appData.filterSorts = { ...filterSorts };
                saveToStorage();
              } catch (e) {
                console.warn('persist filterSorts failed', e);
              }
              // ファイル名から日時を抽出して保存（ストレージに保持するため先にセット）
              try {
                const dt = extractDatetimeFromFilename(file.name);
                if (dt) {
                  appData.fileTimestamp = dt;
                } else {
                  appData.fileTimestamp = null;
                }
                appData.lastFileName = file.name;
                appData.lastFileEncoding = decoded.encoding;
              } catch (err) {
                console.error('timestamp parse error', err);
              }
              saveToStorage();
              showUI();
              updateChart();
              showToast("データを読み込みました ✓");

              // ファイル名表示
              const fileInfo = document.getElementById("fileInfo");
              fileInfo.textContent = `📄 ${file.name} (${decoded.encoding})`;
              fileInfo.classList.remove("hidden");

              // DOM に日時を表示（appData.fileTimestamp を使う）
              const tsEl = document.getElementById("fileTimestamp");
              if (tsEl) {
                tsEl.textContent = appData.fileTimestamp
                  ? "CrowdLog出力日時: " + appData.fileTimestamp
                  : "";
                tsEl.classList.remove("hidden");
              }
            } catch (error) {
              console.error(error);
              showToast("ファイルの解析に失敗しました: " + error.message, true);
            }
          };
          reader.readAsArrayBuffer(file);
        }

        // ========================================
        // CSVパース
        // ========================================
        // CSVパース（引用符内のカンマ・改行、二重引用符 "" を考慮した堅牢版）
        function parseCSV(text) {
          const rows = parseCSVRows(text).filter((r) =>
            r.some((c) => c.trim() !== "")
          );
          if (rows.length < 2) {
            throw new Error("データが不足しています");
          }

          const headers = rows[0].map((h) => (h || "").trim());
          console.log("Headers:", headers);

          // 列インデックスを特定（複数の候補名に対応）
          const colIndex = {
            employee: findColumnIndex(headers, [
              "社員名",
              "担当者名",
              "従業員名",
              "メンバー名",
            ]),
            project: findColumnIndex(headers, [
              "プロジェクト名",
              "プロジェクト",
              "PJ名",
            ]),
            department: findColumnIndex(headers, [
              "部署名",
              "メンバー部署",
              "部署",
              "所属",
            ]),
            type: findColumnIndex(headers, [
              "メンバー種類",
              "予実フラグ",
              "予実",
              "種類",
              "区分",
            ]),
            unit: findColumnIndex(headers, ["工数単位", "単位", "unit"]),
            total: findColumnIndex(headers, ["合計", "計", "Total"]),
          };

          console.log("Column indices:", colIndex);

          // 月列を特定（日付形式のヘッダー）
          const monthColumns = [];
          headers.forEach((header, index) => {
            // YYYY/M/D または YYYY/MM/DD 形式
            if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(header.trim())) {
              monthColumns.push({ index, header: header.trim() });
            }
          });

          console.log("Month columns:", monthColumns);

          // 月次列が見つからない場合、合計列を代替として使う（存在すれば）
          if (monthColumns.length === 0) {
            if (colIndex.total >= 0) {
              monthColumns.push({
                index: colIndex.total,
                header: headers[colIndex.total].trim(),
              });
            } else {
              throw new Error(
                "月次データ列が見つかりません（日付形式: YYYY/M/D）。合計列も見つかりません。"
              );
            }
          }

          // 月リスト作成（重複除去、YYYY/MM形式に変換）
          const monthSet = new Set();
          monthColumns.forEach((col) => {
            const parts = col.header.split("/");
            const monthKey = `${parts[0]}/${parts[1].padStart(2, "0")}`;
            monthSet.add(monthKey);
          });
          appData.months = Array.from(monthSet).sort();

          // データをパース
          appData.records = [];
          const departmentSet = new Set();
          const projectSet = new Set();
          const employeeSet = new Set();
          for (let i = 1; i < rows.length; i++) {
            const values = rows[i];
            if (!values || values.length < 1) continue;

            // 各フィールドを取得（-1の場合は空文字）
            let employee =
              colIndex.employee >= 0
                ? (values[colIndex.employee] || "").trim()
                : "";
            let project =
              colIndex.project >= 0
                ? (values[colIndex.project] || "").trim()
                : "";
            let department =
              colIndex.department >= 0
                ? (values[colIndex.department] || "").trim()
                : "";
            let type =
              colIndex.type >= 0 ? (values[colIndex.type] || "").trim() : "";

            // プロジェクト名からコード部分を除去
            // 例: "103005-9 同年事業" → "同年事業"、"P001 顧客管理" → "顧客管理"
            project = removeCodePrefix(project);

            // 部署名からコード部分を除去
            // 例: "100001 テスト部" → "テスト部"
            department = removeCodePrefix(department);

            // 予実タイプを正規化（予算→予、実績→実）
            let normalizedType = "";
            if (
              type.includes("予算") ||
              type === "予" ||
              type.includes("計画") ||
              type.includes("Plan")
            ) {
              normalizedType = "予";
            } else if (
              type.includes("実績") ||
              type === "実" ||
              type.includes("Actual")
            ) {
              normalizedType = "実";
            }

            // 必須フィールドのチェック（従業員と予実タイプは必須）
            if (!employee || !normalizedType) {
              console.log(
                `Skipping row ${i}: employee="${employee}", type="${type}"`
              );
              continue;
            }

            // プロジェクトと部署が空の場合はデフォルト値
            if (!project) project = "(未設定)";
            if (!department) department = "(未設定)";

            departmentSet.add(department);
            projectSet.add(project);
            employeeSet.add(employee);

            // 月次データを収集
            const monthlyData = {};
            // 行ごとの単位判定
            // - CSV内の単位が「人日」の場合は時間に換算（* HOURS_PER_DAY）して内部は時間で保持
            // - CSV内の単位が「人時」「時間」「h」等の場合はそのまま時間として扱う
            let multiplier = 1;
            if (colIndex.unit >= 0) {
              const unitVal = (values[colIndex.unit] || "").trim();
              if (/(人日|日|\bdays?\b|\bd\b)/i.test(unitVal)) {
                multiplier = HOURS_PER_DAY;
              } else if (/(人時|時間|h|hours?|hr\b)/i.test(unitVal)) {
                multiplier = 1;
              } else {
                // 不明な単位はデフォルトで時間扱い（安全側）
                multiplier = 1;
              }
            }

            monthColumns.forEach((col) => {
              // ヘッダーが日付形式なら YYYY/MM に整形する。合計列等はそのままヘッダーを使う。
              const parts = col.header.split("/");
              const monthKey =
                parts.length >= 2
                  ? `${parts[0]}/${parts[1].padStart(2, "0")}`
                  : col.header.trim();
              const raw = parseFloat(values[col.index]);
              const value = (isNaN(raw) ? 0 : raw) * multiplier;
              if (!monthlyData[monthKey]) {
                monthlyData[monthKey] = 0;
              }
              monthlyData[monthKey] += value;
            });

            appData.records.push({
              department,
              project,
              employee,
              type: normalizedType,
              monthlyData,
            });
          }

          appData.departments = Array.from(departmentSet).sort();
          appData.projects = Array.from(projectSet).sort();
          appData.employees = Array.from(employeeSet).sort();

          console.log("Parsed records:", appData.records.length);
          console.log("Departments:", appData.departments);
          console.log("Projects:", appData.projects);
          console.log("Employees:", appData.employees);

          // フィルター初期化（全て解除）
          filters.projects = [];
          filters.departments = [];
          filters.employees = [];

          if (appData.records.length === 0) {
            throw new Error(
              "有効なデータが見つかりませんでした。列名を確認してください: 社員名/担当者名、メンバー種類/予実フラグ（予算/実績 or 予/実）"
            );
          }
        }

        // CSVの全テキストから行単位の配列（配列の配列）を返す
        function parseCSVRows(text) {
          const rows = [];
          let cur = [];
          let field = "";
          let inQuotes = false;

          for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const next = text[i + 1];

            if (char === '"') {
              if (inQuotes && next === '"') {
                // エスケープされたダブルクォート
                field += '"';
                i++; // 1文字進める
              } else {
                inQuotes = !inQuotes;
              }
            } else if (char === "," && !inQuotes) {
              cur.push(field);
              field = "";
            } else if ((char === "\n" || char === "\r") && !inQuotes) {
              // 改行処理（CRLF対応）
              if (char === "\r" && next === "\n") {
                // consume CRLF as single newline
                // advance i to skip \n in next loop
                // but outer loop will increment i, so increment once here
                i++;
              }
              cur.push(field);
              rows.push(cur);
              cur = [];
              field = "";
            } else {
              field += char;
            }
          }

          // 残りのフィールド/行を確定
          if (inQuotes) {
            // 終端で引用符が閉じられていない場合は許容して処理を続ける
            inQuotes = false;
          }
          if (field !== "" || cur.length > 0) {
            cur.push(field);
            rows.push(cur);
          }
          return rows;
        }

        // ファイル名から日時を抽出するユーティリティ
        function extractDatetimeFromFilename(name) {
          if (!name) return null;
          const base = name.replace(/\.[^.]+$/, '');
          const patterns = [
            /(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})[_-]?(?<h>\d{2})(?<min>\d{2})(?<s>\d{2})?/, // YYYYMMDD_HHMMSS
            /(?<y>\d{4})[-_.](?<m>\d{2})[-_.](?<d>\d{2})[ T](?<h>\d{2})[:.](?<min>\d{2})[:.](?<s>\d{2})/, // YYYY-MM-DD HH:MM:SS
            /(?<y>\d{4})[-_.](?<m>\d{2})[-_.](?<d>\d{2})/, // YYYY-MM-DD
            /(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})/ // YYYYMMDD
          ];
          for (const p of patterns) {
            const m = base.match(p);
            if (m && m.groups && m.groups.y) {
              const y = m.groups.y;
              const mo = m.groups.m || '01';
              const d = m.groups.d || '01';
              const h = m.groups.h || '00';
              const min = m.groups.min || '00';
              const s = m.groups.s || '00';
              const iso = `${y}-${mo}-${d}T${h}:${min}:${s}`;
              const dt = new Date(iso);
              if (!isNaN(dt.getTime())) {
                return dt.toLocaleString();
              }
            }
          }
          return null;
        }

        // ArrayBuffer を文字列に変換（自動判定 or 指定）。戻り値は { text, encoding }
        function decodeArrayBufferToText(buffer, preferred = 'auto') {
          const bytes = new Uint8Array(buffer);

          const tryDecode = (enc) => {
            try {
              // 一部ブラウザでは 'shift_jis' の代わりに 'shift-jis' や 'windows-31j' が必要
              const dec = new TextDecoder(enc, { fatal: false });
              return dec.decode(bytes);
            } catch (e) {
              return null;
            }
          };

          // BOM 判定（UTF-8 BOM）
          if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
            const txt = tryDecode('utf-8');
            return { text: txt || '', encoding: 'UTF-8 (BOM)' };
          }

          if (preferred === 'utf-8') {
            const txt = tryDecode('utf-8') || '';
            return { text: txt, encoding: 'UTF-8' };
          }
          if (preferred === 'shift_jis') {
            const txt = tryDecode('shift_jis') || tryDecode('shift-jis') || tryDecode('windows-31j') || '';
            return { text: txt, encoding: 'Shift_JIS' };
          }

          // 自動判定: まず UTF-8 を試す。失敗や置換文字が多ければ Shift_JIS を試す。
          let utf8 = tryDecode('utf-8') || '';
          const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
          const threshold = Math.max(2, Math.floor(utf8.length * 0.01));
          if (replacementCount > threshold) {
            const sj = tryDecode('shift_jis') || tryDecode('shift-jis') || tryDecode('windows-31j');
            if (sj) return { text: sj, encoding: 'Shift_JIS (auto)' };
          }

          // 置換文字が少なければ UTF-8 を使う
          return { text: utf8, encoding: 'UTF-8 (auto)' };
        }

        // コードプレフィックスを除去する関数
        // 例: "103005-9 同年事業" → "同年事業"
        // 例: "100001 テスト部" → "テスト部"
        // 例: "P001 顧客管理" → "顧客管理"
        function removeCodePrefix(text) {
          if (!text) return text;

          // パターン: 「数字やアルファベット、ハイフンで構成されるコード + スペース + 日本語名」
          // 例: "103005-9 同年事業", "100001 テスト部", "P001 プロジェクト名"
          const match = text.match(/^[A-Za-z0-9\-_]+\s+(.+)$/);
          if (match) {
            return match[1].trim();
          }
          return text;
        }

        function findColumnIndex(
          headers,
          possibleNames,
          excludePatterns = ["コード", "code", "Code", "ID"]
        ) {
          // まず、除外パターンに該当しない列で検索
          for (let i = 0; i < headers.length; i++) {
            const header = headers[i].trim();
            // 除外パターンに該当する場合はスキップ
            if (excludePatterns.some((pattern) => header.includes(pattern))) {
              continue;
            }
            if (possibleNames.some((name) => header.includes(name))) {
              return i;
            }
          }

          // 見つからない場合は除外パターンを無視して再検索
          for (let i = 0; i < headers.length; i++) {
            const header = headers[i].trim();
            if (possibleNames.some((name) => header.includes(name))) {
              return i;
            }
          }
          return -1;
        }

        // ========================================
        // ========================================
        // ストレージ保存・読み込み
        // ========================================

        // ========================================
        // UI表示
        // ========================================
        function showUI() {
          const summaryCards = document.getElementById("summaryCards");
          if (summaryCards) {
            summaryCards.classList.remove("hidden");
          }
          document.getElementById("filterSection").classList.remove("hidden");
          document
            .getElementById("favoritesSection")
            .classList.remove("hidden");
          document.getElementById("chartSection").classList.remove("hidden");
          document.getElementById("btnClear").classList.remove("hidden");

          loadSavedFilters();
          updateFiltersUI();
          updatePeriodSelector();
          updateSummary();
        }

        /* Period/Reset handlers are defined later (more robust). Duplicate simple implementations removed. */

        function updateFiltersUI() {
          // フィルタソート選択肢の表示を現在の設定に合わせる
          try {
            const projSel = document.querySelector('#projectFilters .filter-sort-select');
            if (projSel) projSel.value = filterSorts.projects || 'name_asc';
            const deptSel = document.querySelector('#departmentFilters .filter-sort-select');
            if (deptSel) deptSel.value = filterSorts.departments || 'name_asc';
            const empSel = document.querySelector('#employeeFilters .filter-sort-select');
            if (empSel) empSel.value = filterSorts.employees || 'name_asc';
          } catch (e) {
            console.warn('updateFiltersUI: set select value failed', e);
          }
          // プロジェクトフィルター（安全にDOMで構築）
          const projectItems = document.getElementById("projectFilterItems");
          projectItems.innerHTML = "";
          getSortedItems("projects").forEach((p) => {
            const label = document.createElement("label");
            label.className =
              "filter-chip" + (filters.projects.includes(p) ? " active" : "");
            label.setAttribute("data-value", p);

            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = p;
            if (filters.projects.includes(p)) input.checked = true;

            // ラベルクリックで確実にトグルする（input change に依存しない）
            label.addEventListener("click", (ev) => {
              ev.preventDefault();
              toggleFilter("projects", p);
            });

            label.appendChild(input);
            label.appendChild(document.createTextNode(p));
            projectItems.appendChild(label);
          });

          // 部署フィルター（安全にDOMで構築）
          const departmentItems = document.getElementById(
            "departmentFilterItems"
          );
          departmentItems.innerHTML = "";
          getSortedItems("departments").forEach((d) => {
            const label = document.createElement("label");
            label.className =
              "filter-chip" +
              (filters.departments.includes(d) ? " active" : "");
            label.setAttribute("data-value", d);

            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = d;
            if (filters.departments.includes(d)) input.checked = true;

            label.addEventListener("click", (ev) => {
              ev.preventDefault();
              toggleFilter("departments", d);
            });

            label.appendChild(input);
            label.appendChild(document.createTextNode(d));
            departmentItems.appendChild(label);
          });

          // 従業員フィルター（安全にDOMで構築）
          const employeeItems = document.getElementById("employeeFilterItems");
          employeeItems.innerHTML = "";
          getSortedItems("employees").forEach((e) => {
            const label = document.createElement("label");
            label.className =
              "filter-chip" + (filters.employees.includes(e) ? " active" : "");
            label.setAttribute("data-value", e);

            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = e;
            if (filters.employees.includes(e)) input.checked = true;

            label.addEventListener("click", (ev) => {
              ev.preventDefault();
              toggleFilter("employees", e);
            });

            label.appendChild(input);
            label.appendChild(document.createTextNode(e));
            employeeItems.appendChild(label);
          });

          // 検索状態を復元（ただし最初の更新時は検索テキストを保持）
          const projectSearch = document.getElementById("projectSearch").value;
          if (projectSearch) filterItems("projects", projectSearch);

          const departmentSearch =
            document.getElementById("departmentSearch").value;
          if (departmentSearch) filterItems("departments", departmentSearch);

          const employeeSearch =
            document.getElementById("employeeSearch").value;
          if (employeeSearch) {
            filterItems("employees", employeeSearch);
          } else {
            // 検索テキストが空の場合は全従業員チップを表示
            const allEmpChips = document
              .getElementById("employeeFilterItems")
              .querySelectorAll(".filter-chip");
            allEmpChips.forEach((chip) => {
              chip.style.display = "flex";
            });
          }
        }

        function filterItems(type, searchText) {
          const containerId =
            type === "projects"
              ? "projectFilterItems"
              : type === "departments"
              ? "departmentFilterItems"
              : "employeeFilterItems";
          const container = document.getElementById(containerId);
          const chips = container.querySelectorAll(".filter-chip");
          const lowerSearch = searchText.toLowerCase();
          chips.forEach((chip) => {
            const value = chip.getAttribute("data-value").toLowerCase();
            if (value.includes(lowerSearch)) {
              chip.style.display = "flex";
            } else {
              chip.style.display = "none";
            }
          });
        }

        function escapeHtml(text) {
          if (text == null) return "";
          return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function toggleFilter(type, value) {
          console.log(
            `toggleFilter called: type=${type}, value=${value}, before:`,
            JSON.parse(JSON.stringify(filters))
          );
          const index = filters[type].indexOf(value);
          if (index > -1) {
            // 解除処理
            if (type === "departments") {
              // 部署解除時は、その部署に紐づく従業員選択を解除するが、
              // 他の選択済み部署に所属する従業員は残す
              const departmentEmployees = appData.records
                .filter((r) => r.department === value)
                .map((r) => r.employee);
              const uniqueEmployees = [...new Set(departmentEmployees)];
              const otherSelectedDepts = filters.departments.filter(
                (d) => d !== value
              );
              uniqueEmployees.forEach((emp) => {
                const stillInOtherDept = appData.records.some(
                  (r) =>
                    r.employee === emp &&
                    otherSelectedDepts.includes(r.department)
                );
                if (!stillInOtherDept) {
                  const ei = filters.employees.indexOf(emp);
                  if (ei > -1) filters.employees.splice(ei, 1);
                }
              });
            }
            filters[type].splice(index, 1);
          } else {
            // 選択処理
            filters[type].push(value);

            // 部署選択時に、その部署の従業員を自動選択
            if (type === "departments") {
              const departmentEmployees = appData.records
                .filter((r) => r.department === value)
                .map((r) => r.employee);
              const uniqueEmployees = [...new Set(departmentEmployees)];

              uniqueEmployees.forEach((emp) => {
                if (!filters.employees.includes(emp)) {
                  filters.employees.push(emp);
                }
              });
            }
          }
          console.log(
            `toggleFilter after:`,
            JSON.parse(JSON.stringify(filters))
          );
          updateFiltersUI();
          updateChart();
          persistCurrentFilters();
          updateSummary();
        }

        function selectAll(type) {
          filters[type] = [...appData[type]];
          updateFiltersUI();
          updateChart();
          updateSummary();
          persistCurrentFilters();
        }

        function deselectAll(type) {
          filters[type] = [];
          updateFiltersUI();
          updateChart();
          updateSummary();
          persistCurrentFilters();
        }

        // ========================================
        // コントロールリスナー
        // ========================================
        function initControlListeners() {
          // 分析タイプ
          document
            .querySelectorAll('input[name="analysisType"]')
            .forEach((radio) => {
              radio.addEventListener("change", () => {
                updateRadioStyles("analysisType");
                updateChart();
              });
            });

          // グラフ種類
          document
            .querySelectorAll('input[name="chartType"]')
            .forEach((radio) => {
              radio.addEventListener("change", () => {
                updateRadioStyles("chartType");
                updateChart();
              });
            });

          // 単位タイプ
          document
            .querySelectorAll('input[name="unitType"]')
            .forEach((radio) => {
              radio.addEventListener("change", () => {
                updateRadioStyles("unitType");
                updateChart();
                updateSummary();
              });
            });

          // 検索入力のデバウンス処理（パフォーマンス向上）
          const debounce = (fn, wait) => {
            let t;
            return function (...args) {
              clearTimeout(t);
              t = setTimeout(() => fn.apply(this, args), wait);
            };
          };

          const projectSearch = document.getElementById("projectSearch");
          if (projectSearch)
            projectSearch.addEventListener(
              "input",
              debounce((e) => filterItems("projects", e.target.value), 250)
            );

          const departmentSearch = document.getElementById("departmentSearch");
          if (departmentSearch)
            departmentSearch.addEventListener(
              "input",
              debounce((e) => filterItems("departments", e.target.value), 250)
            );

          const employeeSearch = document.getElementById("employeeSearch");
          if (employeeSearch)
            employeeSearch.addEventListener(
              "input",
              debounce((e) => filterItems("employees", e.target.value), 250)
            );

          // 基準線コントロール: チェックと入力変更で再描画
          const yLineToggle = document.getElementById("yLineToggle");
          const yLineInput = document.getElementById("yLineValue");
          if (yLineToggle) {
            yLineToggle.addEventListener("change", () => {
              updateChart();
            });
          }
          if (yLineInput) {
            yLineInput.addEventListener("input", debounce(() => updateChart(), 200));
            yLineInput.addEventListener("change", () => updateChart());
          }
        }

        function updateRadioStyles(groupId) {
          const container = document.getElementById(groupId);
          container.querySelectorAll(".radio-item").forEach((item) => {
            const input = item.querySelector("input");
            item.classList.toggle("active", input.checked);
          });
        }

        // ========================================
        // サマリー更新
        // ========================================
        function updateSummary() {
          const filteredRecords = getFilteredRecords();

          let totalPlanned =  0;
          let totalActual = 0;

          filteredRecords.forEach((record) => {
            const total = sumMonthlyData(record.monthlyData);
            if (record.type === "予") {
              totalPlanned += total;
            } else if (record.type === "実") {
              totalActual += total;
            }
          });

          const diff = totalActual - totalPlanned;
          const rate =
            totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;

          const unit = getUnitLabel();
          const displayPlanned = convertToDisplayUnit(totalPlanned);
          const displayActual = convertToDisplayUnit(totalActual);
          const displayDiff = convertToDisplayUnit(diff);

          const plannedEl = document.getElementById("totalPlanned");
          const actualEl = document.getElementById("totalActual");
          const diffEl = document.getElementById("totalDiff");
          const rateEl = document.getElementById("totalRate");

          if (plannedEl) {
            plannedEl.textContent = displayPlanned.toFixed(1) + unit;
          }
          if (actualEl) {
            actualEl.textContent = displayActual.toFixed(1) + unit;
          }
          if (diffEl) {
            diffEl.textContent =
              (displayDiff >= 0 ? "+" : "") + displayDiff.toFixed(1) + unit;
            diffEl.className =
              "summary-card-value " +
              (diff >= 0 ? "diff-positive" : "diff-negative");
          }
          if (rateEl) {
            rateEl.textContent = rate.toFixed(1) + "%";
            rateEl.className =
              "summary-card-value " +
              (rate >= 100 ? "diff-positive" : "diff-negative");
          }
        }

        // ========================================
        // フィルター済みレコード取得
        // ========================================
        function getFilteredRecords() {
          // 全フィルタが空（全解除）の場合は「表示なし」とする
          if (
            (!filters.projects || filters.projects.length === 0) &&
            (!filters.departments || filters.departments.length === 0) &&
            (!filters.employees || filters.employees.length === 0)
          ) {
            return [];
          }

          // プロジェクト選択が空の場合は全選択扱い（ワイルドカード）
          const projectSelected = filters.projects && filters.projects.length > 0;

          return appData.records.filter((record) => {
            const passProject =
              !projectSelected || filters.projects.includes(record.project);

            const deptSelected = filters.departments.length > 0;
            const empSelected = filters.employees.length > 0;

            // 振る舞い:
            // - どちらも未選択 => ワイルドカード（true）
            // - 片方だけ選択 => その選択でフィルタ
            // - 両方選択 => 従業員選択で絞り込む（部署と従業員のAND）
            // ロジック修正:
            // - 従業員が選択されている場合は、その従業員を優先して反映する（部署の選択に関わらず含める）
            // - 部署のみ選択されている場合は部署でフィルタ
            // - どちらも未選択の場合はワイルドカード
            let passDeptEmp = true;
            if (deptSelected && empSelected) {
              // 両方選択時は「部署に属する」または「従業員が選択されている」どちらかで通す
              passDeptEmp =
                filters.departments.includes(record.department) ||
                filters.employees.includes(record.employee);
            } else if (deptSelected) {
              passDeptEmp = filters.departments.includes(record.department);
            } else if (empSelected) {
              passDeptEmp = filters.employees.includes(record.employee);
            }

            return passProject && passDeptEmp;
          });
        }

        // ========================================
        // 期間フィルター制御
        // ========================================
        function updatePeriodSelector() {
          const startSelect = document.getElementById("periodStart");
          const endSelect = document.getElementById("periodEnd");

          if (!startSelect || !endSelect) return;

          // 選択肢のクリア（保持している値があれば覚えておく）
          const currentStart = filters.periodStart;
          const currentEnd = filters.periodEnd;

          // プレースホルダ不要のため初期空にする（後で月リストで埋める）
          startSelect.innerHTML = '';
          endSelect.innerHTML = '';

          const months = appData.months;

          months.forEach((month) => {
            const opt1 = document.createElement("option");
            opt1.value = month;
            opt1.textContent = month;
            startSelect.appendChild(opt1);

            const opt2 = document.createElement("option");
            opt2.value = month;
            opt2.textContent = month;
            endSelect.appendChild(opt2);
          });

          // 未設定の場合は自動設定（全期間）
          if (!filters.periodStart && months.length > 0) {
            filters.periodStart = months[0];
          }
          if (!filters.periodEnd && months.length > 0) {
            filters.periodEnd = months[months.length - 1];
          }

          // プルダウンに反映
          startSelect.value = filters.periodStart;
          endSelect.value = filters.periodEnd;
        }

        function updatePeriodFilter() {
          const startSelect = document.getElementById("periodStart");
          const endSelect = document.getElementById("periodEnd");

          filters.periodStart = startSelect.value;
          filters.periodEnd = endSelect.value;

          console.log("updatePeriodFilter: periodStart=", filters.periodStart, "periodEnd=", filters.periodEnd);

          // 開始月と終了月が逆転している場合は終了月を開始月に合わせる
          if (filters.periodStart && filters.periodEnd && filters.periodStart > filters.periodEnd) {
            filters.periodEnd = filters.periodStart;
            // UI反映
            endSelect.value = filters.periodEnd;
            showToast("開始月が終了月より後です。終了月を開始月に合わせました。", false);
            console.log("period adjusted: periodEnd set to", filters.periodEnd);
          }

          // 期間変更時
          updateChart();
          updateSummary();
        }

        function resetPeriod() {
          const months = appData.months;
          if (months.length > 0) {
            filters.periodStart = months[0];
            filters.periodEnd = months[months.length - 1];
            updatePeriodSelector(); // UIに反映
            updateChart();
            updateSummary();
          }
        }

        // 期間フィルターを適用した月リストを取得
        function getFilteredMonths() {
          let months = [...appData.months];

          if (filters.periodStart) {
            months = months.filter((m) => m >= filters.periodStart);
          }
          if (filters.periodEnd) {
            months = months.filter((m) => m <= filters.periodEnd);
          }

          console.log("getFilteredMonths ->", months, "(filters)", filters.periodStart, filters.periodEnd);

          return months;
        }

        // ========================================
        // テーブルソート機能
        // ========================================
        let currentChartData = [];
        let tableSort = { key: null, order: "asc" };

        function sortTable(key) {
          if (tableSort.key === key) {
            if (tableSort.order === "asc") {
              tableSort.order = "desc";
            } else if (tableSort.order === "desc") {
              tableSort.key = null; // ソート解除
              tableSort.order = "asc";
            }
          } else {
            tableSort.key = key;
            tableSort.order = "asc";
          }

          // データのソート
          sortChartData(currentChartData);

          // グラフ再描画
          const chartType = document.querySelector(
            'input[name="chartType"]:checked'
          ).value;
          if (chartType === "bar") {
            drawBarChart(currentChartData);
          } else {
            drawLineChart(currentChartData);
          }

          // テーブル再描画
          drawTable(currentChartData);
        }

        // ========================================
        // 単位変換用定数と関数
        // ========================================
        const HOURS_PER_DAY = 7.5;

        function getUnitType() {
          const radio = document.querySelector(
            'input[name="unitType"]:checked'
          );
          return radio ? radio.value : "hours";
        }

        function convertToDisplayUnit(hours) {
          if (getUnitType() === "days") {
            return hours / HOURS_PER_DAY;
          }
          return hours;
        }

        function getUnitLabel() {
          return getUnitType() === "days" ? "人日" : "h";
        }

        // キリの良い目盛り間隔を計算
        function calculateNiceStep(max, targetTicks = 5) {
          if (max <= 0) return 10;

          // 大まかなステップ幅
          const roughStep = max / targetTicks;

          // 桁数を求める (例: 85 -> 10, 120 -> 100)
          const power = Math.floor(Math.log10(roughStep));
          const magnitude = Math.pow(10, power);

          // 正規化されたステップ (例: 8.5, 1.2)
          const normalizedStep = roughStep / magnitude;

          let niceStep;
          if (normalizedStep <= 1) {
            niceStep = 1;
          } else if (normalizedStep <= 2) {
            niceStep = 2;
          } else if (normalizedStep <= 5) {
            niceStep = 5;
          } else {
            niceStep = 10;
          }

          return niceStep * magnitude;
        }

        // 期間フィルターを適用して月次データを合計
        function sumMonthlyData(monthlyData) {
          const filteredMonths = getFilteredMonths();
          let total = 0;

          filteredMonths.forEach((month) => {
            // monthlyData のキーが YYYY/MM 形式であることを想定
            if (monthlyData[month]) {
              total += monthlyData[month];
            }
          });

          console.log("sumMonthlyData for record", monthlyData, "-> total=", total);

          return total;
        }

        // ========================================
        // グラフ描画
        // ========================================
        function updateChart() {
          const analysisType = document.querySelector(
            'input[name="analysisType"]:checked'
          ).value;
          const chartType = document.querySelector(
            'input[name="chartType"]:checked'
          ).value;
          const filteredRecords = getFilteredRecords();
          console.log("updateChart called", { analysisType, chartType, filters, filteredCount: filteredRecords.length });

          let chartData;
          switch (analysisType) {
            case "overall":
              chartData = aggregateOverall(filteredRecords);
              break;
            case "project":
              chartData = aggregateByKey(filteredRecords, "project");
              break;
            case "department":
              chartData = aggregateByKey(filteredRecords, "department");
              break;
            case "employee":
              chartData = aggregateByKey(filteredRecords, "employee");
              break;
            case "monthly":
              chartData = aggregateByMonth(filteredRecords);
              break;
          }

          // ソート
          console.log("chartData computed:", chartData);
          sortChartData(chartData);

          if (chartType === "bar") {
            console.log("calling drawBarChart with", chartData.length);
            drawBarChart(chartData);
          } else {
            console.log("calling drawLineChart with", chartData.length);
            drawLineChart(chartData);
          }

          // テーブル描画
          drawTable(chartData);
          console.log("updateChart finished");
        }

        function aggregateOverall(records) {
          let planned = 0;
          let actual = 0;

          records.forEach((record) => {
            const total = sumMonthlyData(record.monthlyData);
            if (record.type === "予") {
              planned += total;
            } else if (record.type === "実") {
              actual += total;
            }
          });

          return [
            {
              label: "全体",
              planned,
              actual,
            },
          ];
        }

        function aggregateByKey(records, key) {
          const grouped = {};
          const empDepts = {};

          records.forEach((record) => {
            const groupKey = record[key];

            if (key === "employee" && record.department) {
              empDepts[groupKey] = record.department;
            }

            if (!grouped[groupKey]) {
              grouped[groupKey] = { planned: 0, actual: 0 };
            }
            const total = sumMonthlyData(record.monthlyData);
            if (record.type === "予") {
              grouped[groupKey].planned += total;
            } else if (record.type === "実") {
              grouped[groupKey].actual += total;
            }
          });

          return Object.entries(grouped).map(([label, data]) => {
            const item = {
              label,
              planned: data.planned,
              actual: data.actual,
            };
            if (key === "employee") {
              item.department = empDepts[label] || "-";
            }
            return item;
          });
        }

        function aggregateByMonth(records) {
          const filteredMonths = getFilteredMonths();
          const grouped = {};

          filteredMonths.forEach((month) => {
            grouped[month] = { planned: 0, actual: 0 };
          });

          records.forEach((record) => {
            Object.entries(record.monthlyData).forEach(([month, value]) => {
              if (grouped[month]) {
                if (record.type === "予") {
                  grouped[month].planned += value;
                } else if (record.type === "実") {
                  grouped[month].actual += value;
                }
              }
            });
          });

          return Object.entries(grouped).map(([label, data]) => ({
            label,
            planned: data.planned,
            actual: data.actual,
          }));
        }

        // ========================================
        // データソート処理（グラフ・テーブル共通）
        // ========================================
        function sortChartData(data) {
          if (!tableSort.key || !data) return;

          data.sort((a, b) => {
            let valA, valB;
            if (tableSort.key === "label") {
              valA = a.label;
              valB = b.label;
              return tableSort.order === "asc"
                ? valA.localeCompare(valB, "ja")
                : valB.localeCompare(valA, "ja");
            } else if (tableSort.key === "department") {
              valA = a.department || "";
              valB = b.department || "";
              return tableSort.order === "asc"
                ? valA.localeCompare(valB, "ja")
                : valB.localeCompare(valA, "ja");
            } else {
              const getVal = (item, k) => {
                if (k === "planned") return item.planned;
                if (k === "actual") return item.actual;
                if (k === "diff") return item.actual - item.planned;
                if (k === "rate")
                  return item.planned > 0
                    ? (item.actual / item.planned) * 100
                    : 0;
                return 0;
              };
              valA = getVal(a, tableSort.key);
              valB = getVal(b, tableSort.key);
              return tableSort.order === "asc" ? valA - valB : valB - valA;
            }
          });
        }

        // ========================================
        // データテーブル描画
        // ========================================
        function drawTable(data) {
          // グローバル変数更新
          if (data) currentChartData = data;
          const targetData = currentChartData;
          const tbody = document.querySelector("#dataTable tbody");
          const container = document.getElementById("dataTableContainer");

          if (!targetData || targetData.length === 0) {
            container.style.display = "none";
            return;
          }
          container.style.display = "block";

          const unit = getUnitLabel();

          // 分析タイプ取得
          const currentAnalysisType = document.querySelector(
            'input[name="analysisType"]:checked'
          ).value;
          const showDept = currentAnalysisType === "employee";

          let labelText = "項目";
          if (currentAnalysisType === "project") labelText = "プロジェクト名";
          else if (currentAnalysisType === "department") labelText = "部署名";
          else if (currentAnalysisType === "employee") labelText = "氏名";
          else if (currentAnalysisType === "monthly") labelText = "年月";

          // データ変換とソート用プロパティ追加
          let processedData = targetData.map((item) => {
            const planned = convertToDisplayUnit(item.planned);
            const actual = convertToDisplayUnit(item.actual);
            const diff = actual - planned;
            const rate = planned > 0 ? (actual / planned) * 100 : 0;
            return {
              ...item,
              displayPlanned: planned,
              displayActual: actual,
              diff,
              rate,
            };
          });

          // ヘッダー動的更新
          const thead = document.querySelector("#dataTable thead");
          let headerHTML = `<tr><th class="align-left" data-key="label">${labelText}</th>`;
          if (showDept) {
            headerHTML +=
              '<th class="align-left" data-key="department">部署</th>';
          }
          headerHTML +=
            '<th data-key="planned">予定</th><th data-key="actual">実績</th><th data-key="diff">差異</th><th data-key="rate">到達率</th></tr>';
          thead.innerHTML = headerHTML;

          // ヘッダー更新
          updateTableHeader();

          let totalPlanned = 0;
          let totalActual = 0;

          const rows = processedData
            .map((item) => {
              totalPlanned += item.displayPlanned;
              totalActual += item.displayActual;

              const safeLabel = escapeHtml(item.label);
              const deptCell = showDept
                ? `<td class="align-left">${escapeHtml(
                    item.department || "-"
                  )}</td>`
                : "";

              return `
                    <tr>
                        <td class="align-left">${safeLabel}</td>
                        ${deptCell}
                        <td>${item.displayPlanned.toFixed(1)}${unit}</td>
                        <td>${item.displayActual.toFixed(1)}${unit}</td>
                        <td style="color: ${
                          item.diff > 0
                            ? "#5c9476"
                            : item.diff < 0
                            ? "#ef4444"
                            : "inherit"
                        }">
                            ${item.diff > 0 ? "+" : ""}${item.diff.toFixed(
                1
              )}${unit}
                        </td>
                        <td>${item.rate.toFixed(1)}%</td>
                    </tr>
                `;
            })
            .join("");

          // 合計行
          const totalDiff = totalActual - totalPlanned;
          const totalRate =
            totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;

          const totalRow = `
                <tr style="font-weight: bold; background-color: var(--bg-tertiary);">
                    <td class="align-left" colspan="${
                      showDept ? 2 : 1
                    }">合計</td>
                    <td>${totalPlanned.toFixed(1)}${unit}</td>
                    <td>${totalActual.toFixed(1)}${unit}</td>
                    <td style="color: ${
                      totalDiff > 0
                        ? "#5c9476"
                        : totalDiff < 0
                        ? "#ef4444"
                        : "inherit"
                    }">
                        ${totalDiff > 0 ? "+" : ""}${totalDiff.toFixed(
            1
          )}${unit}
                    </td>
                    <td>${totalRate.toFixed(1)}%</td>
                </tr>
            `;

          tbody.innerHTML = rows + totalRow;
        }

        function updateTableHeader() {
          const currentAnalysisType = document.querySelector(
            'input[name="analysisType"]:checked'
          ).value;
          let labelText = "項目";
          if (currentAnalysisType === "project") labelText = "プロジェクト名";
          else if (currentAnalysisType === "department") labelText = "部署名";
          else if (currentAnalysisType === "employee") labelText = "氏名";
          else if (currentAnalysisType === "monthly") labelText = "年月";

          const headers = document.querySelectorAll("#dataTable th");
          headers.forEach((th) => {
            const key = th.getAttribute("data-key");
            if (!key) return;

            th.onclick = () => sortTable(key);

            const textBase =
              key === "label"
                ? labelText
                : key === "department"
                ? "部署"
                : key === "planned"
                ? "予定"
                : key === "actual"
                ? "実績"
                : key === "diff"
                ? "差異"
                : "到達率";

            let iconChar = "▲";
            let iconClass = "sort-icon";

            if (tableSort.key === key) {
              iconChar = tableSort.order === "asc" ? "▲" : "▼";
              iconClass += " active";
              th.style.backgroundColor = "#eef2f0";
            } else {
              th.style.backgroundColor = "";
            }

            th.innerHTML = `${textBase}<span class="${iconClass}">${iconChar}</span>`;
          });
        }

        // ========================================
        // 棒グラフ描画
        // ========================================
        function drawBarChart(data) {
          const canvas = document.getElementById("chart");

          // キャンバスサイズ調整（高DPI対応）
          const containerWidth = canvas.parentElement.offsetWidth - 50;
          const cssWidth = Math.max(containerWidth, 600);
          const cssHeight = 350;
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.round(cssWidth * ratio);
          canvas.height = Math.round(cssHeight * ratio);
          canvas.style.width = cssWidth + "px";
          canvas.style.height = cssHeight + "px";
          const ctx = canvas.getContext("2d");
          ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

          const width = cssWidth;
          const height = cssHeight;
          let padding = { top: 40, right: 40, bottom: 120, left: 80 };
          let chartWidth = width - padding.left - padding.right;
          let chartHeight = height - padding.top - padding.bottom;

          // クリア
          ctx.clearRect(0, 0, width, height);

          if (data.length === 0) {
            ctx.fillStyle = "#a0a0b0";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("表示するデータがありません", width / 2, height / 2);
            return;
          }

          // 単位変換を適用したデータを作成
          const displayData = data.map((d) => ({
            label: d.label,
            planned: convertToDisplayUnit(d.planned),
            actual: convertToDisplayUnit(d.actual),
          }));

          // 単位取得
          const unit = getUnitLabel();

          // データ上の最大値
          const dataMax =
            Math.max(...displayData.flatMap((d) => [d.planned, d.actual])) || 0;

          // キリの良いステップを計算
          const step = calculateNiceStep(dataMax, 5);

          // ステップの倍数に切り上げ（最大値）
          const maxValue = Math.ceil(dataMax / step) * step || step;

          // グリッド線
          ctx.strokeStyle = "#d1d5db";
          ctx.lineWidth = 1;

          const gridLines = Math.round(maxValue / step);

          for (let i = 0; i <= gridLines; i++) {
            const value = step * i;
            const ratio = value / maxValue;
            const y = padding.top + chartHeight - chartHeight * ratio;

            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            // Y軸ラベル
            ctx.fillStyle = "#5a5a7a";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "right";
            // 整数なら少数点なし、少数なら1桁
            const labelValue = Number.isInteger(step)
              ? value.toString()
              : value.toFixed(1);
            ctx.fillText(labelValue + unit, padding.left - 10, y + 4);
          }

          // 任意のYライン描画
          try {
            const yLineToggle = document.getElementById("yLineToggle");
            const yLineInput = document.getElementById("yLineValue");
            if (yLineToggle && yLineToggle.checked && yLineInput) {
              const yVal = parseFloat(yLineInput.value);
              if (!isNaN(yVal) && maxValue > 0) {
                const ratioVal = Math.max(0, Math.min(yVal / (maxValue || 1), 1));
                const y = padding.top + chartHeight - chartHeight * ratioVal;
                ctx.save();
                ctx.strokeStyle = "rgba(200,40,40,0.9)";
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();
                ctx.setLineDash([]);
                // ラベル
                ctx.fillStyle = "rgba(200,40,40,0.95)";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "right";
                ctx.fillText(yVal + getUnitLabel(), width - padding.right - 6, y - 6);
                ctx.restore();
              }
            }
          } catch (e) {
            console.warn("yLine draw error", e);
          }

          // 棒グラフ描画
          const groupWidth = chartWidth / displayData.length;
          const barWidth = Math.min(groupWidth * 0.35, 60);
          const gap = barWidth * 0.2;

          // ラベルの回転判定
          ctx.font = "11px sans-serif";
          const maxLabelWidth = groupWidth - 10;
          const maxLabelPixel = Math.max(...displayData.map((d) => ctx.measureText(d.label).width));
          let rotateLabels = displayData.some(
            (d) => ctx.measureText(d.label).width > maxLabelWidth
          );

          // 回転ラベルの場合、左端が切れないことがあるため左余白を増やす
          if (rotateLabels && displayData.length > 0) {
            const angleCos = Math.cos(Math.PI / 6); // 30deg
            const requiredLeft = Math.ceil(maxLabelPixel * angleCos - groupWidth / 2 + 12);
            if (requiredLeft > padding.left) {
              padding.left = requiredLeft;
              chartWidth = width - padding.left - padding.right;
              // 再計算
              // groupWidth will be recomputed below after this block
            }
          }

          // 再計算（padding 変更があれば反映）
          const finalChartWidth = chartWidth;
          const finalChartHeight = chartHeight;
          const finalGroupWidth = finalChartWidth / displayData.length;
          // groupWidth/barWidth/gap を最終値で再計算
          const groupWidthFinal = finalGroupWidth;
          const barWidthFinal = Math.min(groupWidthFinal * 0.35, 60);
          const gapFinal = barWidthFinal * 0.2;

          displayData.forEach((item, index) => {
            const x = padding.left + groupWidthFinal * index + groupWidthFinal / 2;

            // 予定（今回はオレンジ）
            const plannedHeight = (item.planned / maxValue) * chartHeight;
            const plannedGradient = ctx.createLinearGradient(
              0,
              padding.top + chartHeight - plannedHeight,
              0,
              padding.top + chartHeight
            );
            plannedGradient.addColorStop(0, "#f59e0b");
            plannedGradient.addColorStop(1, "#d97706");
            ctx.fillStyle = plannedGradient;
            ctx.fillRect(
              x - barWidthFinal - gapFinal / 2,
              padding.top + chartHeight - plannedHeight,
              barWidthFinal,
              plannedHeight
            );

            // 実績（今回は緑）
            const actualHeight = (item.actual / maxValue) * chartHeight;
            const actualGradient = ctx.createLinearGradient(
              0,
              padding.top + chartHeight - actualHeight,
              0,
              padding.top + chartHeight
            );
            actualGradient.addColorStop(0, "#5c9476");
            actualGradient.addColorStop(1, "#4a7a62");
            ctx.fillStyle = actualGradient;
            ctx.fillRect(
              x + gapFinal / 2,
              padding.top + chartHeight - actualHeight,
              barWidthFinal,
              actualHeight
            );

            // 値ラベル
            ctx.fillStyle = "#2f3e35";
            ctx.font = "10px sans-serif";
            ctx.textAlign = "center";
            if (item.planned > 0) {
              ctx.fillText(
                item.planned.toFixed(1),
                x - barWidthFinal / 2 - gapFinal / 2,
                padding.top + chartHeight - plannedHeight - 5
              );
            }
            if (item.actual > 0) {
              ctx.fillText(
                item.actual.toFixed(1),
                x + barWidthFinal / 2 + gapFinal / 2,
                padding.top + chartHeight - actualHeight - 5
              );
            }

            // X軸ラベル
            ctx.fillStyle = "#5a5a7a";
            ctx.font = "11px sans-serif";

            const label = item.label;

            if (rotateLabels) {
              ctx.save();
              ctx.textAlign = "right";
              ctx.translate(x, padding.top + chartHeight + 10);
              ctx.rotate(-Math.PI / 6);
              ctx.fillText(
                label.substring(0, 15) + (label.length > 15 ? "..." : ""),
                0,
                0
              );
              ctx.restore();
            } else {
              ctx.textAlign = "center";
              ctx.fillText(label, x, padding.top + chartHeight + 20);
            }
          });
        }

        // ========================================
        // 折れ線グラフ描画
        // ========================================
        function drawLineChart(data) {
          const canvas = document.getElementById("chart");
          // 高DPI対応でキャンバスを設定
          const containerWidth = canvas.parentElement.offsetWidth - 50;
          const cssWidth = Math.max(containerWidth, 600);
          const cssHeight = 350;
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.round(cssWidth * ratio);
          canvas.height = Math.round(cssHeight * ratio);
          canvas.style.width = cssWidth + "px";
          canvas.style.height = cssHeight + "px";
          const ctx = canvas.getContext("2d");
          ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

          const width = cssWidth;
          const height = cssHeight;
          let padding = { top: 40, right: 40, bottom: 120, left: 80 };
          let chartWidth = width - padding.left - padding.right;
          let chartHeight = height - padding.top - padding.bottom;

          ctx.clearRect(0, 0, width, height);

          if (data.length === 0) {
            ctx.fillStyle = "#5a5a7a";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("表示するデータがありません", width / 2, height / 2);
            return;
          }

          // 単位変換を適用したデータを作成
          const displayData = data.map((d) => ({
            label: d.label,
            planned: convertToDisplayUnit(d.planned),
            actual: convertToDisplayUnit(d.actual),
          }));

          // 単位取得
          const unit = getUnitLabel();

          // データ上の最大値
          const dataMax =
            Math.max(...displayData.flatMap((d) => [d.planned, d.actual])) || 0;

          // キリの良いステップを計算
          const step = calculateNiceStep(dataMax, 5);

          // ステップの倍数に切り上げ（最大値）
          const maxValue = Math.ceil(dataMax / step) * step || step;

          // グリッド線
          ctx.strokeStyle = "#d1d5db";
          ctx.lineWidth = 1;

          const gridLines = Math.round(maxValue / step);

          for (let i = 0; i <= gridLines; i++) {
            const value = step * i;
            const ratio = value / maxValue;
            const y = padding.top + chartHeight - chartHeight * ratio;

            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();

            ctx.fillStyle = "#5a5a7a";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "right";
            const labelValue = Number.isInteger(step)
              ? value.toString()
              : value.toFixed(1);
            ctx.fillText(labelValue + unit, padding.left - 10, y + 4);
          }

          let stepX = chartWidth / (displayData.length - 1 || 1);

          // ラベルの回転判定
          ctx.font = "11px sans-serif";
          const maxLabelWidth = Math.max(stepX - 10, 30);
          const maxLabelPixel = Math.max(...displayData.map((d) => ctx.measureText(d.label).width));
          let rotateLabels = displayData.some(
            (d) => ctx.measureText(d.label).width > maxLabelWidth
          );

          // 回転ラベルのとき、左端が切れないよう左余白を確保
          if (rotateLabels && displayData.length > 0) {
            const angleCos = Math.cos(Math.PI / 6); // 30deg
            const requiredLeft = Math.ceil(maxLabelPixel * angleCos + 12);
            if (requiredLeft > padding.left) {
              padding.left = requiredLeft;
              chartWidth = width - padding.left - padding.right;
              chartHeight = height - padding.top - padding.bottom;
              stepX = chartWidth / (displayData.length - 1 || 1);
            }
          }

          // 予定線（オレンジ）
          ctx.beginPath();
          ctx.strokeStyle = "#d97706";
          ctx.lineWidth = 3;
          displayData.forEach((item, index) => {
            const x = padding.left + stepX * index;
            const y =
              padding.top +
              chartHeight -
              (item.planned / maxValue) * chartHeight;
            if (index === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
          });
          ctx.stroke();

          // 実績線（緑）
          ctx.beginPath();
          ctx.strokeStyle = "#5c9476";
          ctx.lineWidth = 3;
          displayData.forEach((item, index) => {
            const x = padding.left + stepX * index;
            const y =
              padding.top +
              chartHeight -
              (item.actual / maxValue) * chartHeight;
            if (index === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
          });
          ctx.stroke();

          // ポイントとラベル
          displayData.forEach((item, index) => {
            const x = padding.left + stepX * index;

            // 予定ポイント（オレンジ）
            const plannedY =
              padding.top +
              chartHeight -
              (item.planned / maxValue) * chartHeight;
            ctx.beginPath();
            ctx.fillStyle = "#d97706";
            ctx.arc(x, plannedY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(x, plannedY, 2, 0, Math.PI * 2);
            ctx.fill();

            // 実績ポイント（緑）
            const actualY =
              padding.top +
              chartHeight -
              (item.actual / maxValue) * chartHeight;
            ctx.beginPath();
            ctx.fillStyle = "#5c9476";
            ctx.arc(x, actualY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(x, actualY, 2, 0, Math.PI * 2);
            ctx.fill();

            // X軸ラベル
            ctx.fillStyle = "#5a5a7a";
            ctx.font = "11px sans-serif";

            const label = item.label;

            if (rotateLabels) {
              ctx.save();
              ctx.textAlign = "right";
              ctx.translate(x, padding.top + chartHeight + 10);
              ctx.rotate(-Math.PI / 6);
              ctx.fillText(
                label.substring(0, 15) + (label.length > 15 ? "..." : ""),
                0,
                0
              );
              ctx.restore();
            } else {
              ctx.textAlign = "center";
              ctx.fillText(label, x, padding.top + chartHeight + 20);
            }
          });

          // 任意のYライン描画（折れ線も同様に表示）
          try {
            const yLineToggle = document.getElementById("yLineToggle");
            const yLineInput = document.getElementById("yLineValue");
            if (yLineToggle && yLineToggle.checked && yLineInput) {
              const yVal = parseFloat(yLineInput.value);
              if (!isNaN(yVal) && maxValue > 0) {
                const ratioVal = Math.max(0, Math.min(yVal / (maxValue || 1), 1));
                const y = padding.top + chartHeight - chartHeight * ratioVal;
                ctx.save();
                ctx.strokeStyle = "rgba(200,40,40,0.9)";
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = "rgba(200,40,40,0.95)";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "right";
                ctx.fillText(yVal + getUnitLabel(), width - padding.right - 6, y - 6);
                ctx.restore();
              }
            }
          } catch (e) {
            console.warn("yLine draw error", e);
          }
        }

        // ========================================
        // ストレージ管理
        // ========================================
        function saveToStorage() {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
          } catch (e) {
            console.error("保存エラー:", e);
          }
        }

        function persistCurrentFilters() {
          try {
            appData.currentFilters = {
              projects: [...filters.projects],
              departments: [...filters.departments],
              employees: [...filters.employees],
            };
            saveToStorage();
          } catch (e) {
            console.error("persistCurrentFilters error", e);
          }
        }

        function loadFromStorage() {
          try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
              appData = JSON.parse(saved);
              // 従来はここで全項目で filters を上書きしていたが、
              // それだとリロード時に選択順や選択状態が失われる。
              // もし保存された現在のフィルタ順（appData.currentFilters）があればそれを復元し、
              // なければ既存の filters を維持する。
              if (appData.currentFilters && typeof appData.currentFilters === "object") {
                filters.projects = Array.isArray(appData.currentFilters.projects)
                  ? [...appData.currentFilters.projects]
                  : [];
                filters.departments = Array.isArray(appData.currentFilters.departments)
                  ? [...appData.currentFilters.departments]
                  : [];
                filters.employees = Array.isArray(appData.currentFilters.employees)
                  ? [...appData.currentFilters.employees]
                  : [];
              }
              // 保存されたソート設定があれば復元
              if (appData.filterSorts && typeof appData.filterSorts === 'object') {
                filterSorts.projects = appData.filterSorts.projects || filterSorts.projects;
                filterSorts.departments = appData.filterSorts.departments || filterSorts.departments;
                filterSorts.employees = appData.filterSorts.employees || filterSorts.employees;
              }
              // ファイル日時やファイル情報が保存されている場合は DOM に反映
              try {
                const tsEl = document.getElementById("fileTimestamp");
                if (tsEl) {
                  tsEl.textContent = appData.fileTimestamp
                    ? "CrowdLog出力日時: " + appData.fileTimestamp
                    : "";
                  if (appData.fileTimestamp) tsEl.classList.remove("hidden");
                }
                const fileInfo = document.getElementById("fileInfo");
                if (fileInfo && appData.lastFileName) {
                  const enc = appData.lastFileEncoding || "";
                  fileInfo.textContent = `📄 ${appData.lastFileName}${enc ? ' (' + enc + ')' : ''}`;
                  fileInfo.classList.remove("hidden");
                }
              } catch (e) {
                console.warn('restore file info error', e);
              }

              showUI();
              updateChart();
              showToast("保存済みデータを読み込みました");
              // UI復元後にドロップゾーンの高さを再調整
              setTimeout(() => {
                if (window.alignDropZoneHeight) window.alignDropZoneHeight();
              }, 60);
            }
          } catch (e) {
            console.error("読み込みエラー:", e);
          }
        }

        function clearData() {
          if (confirm("データをクリアしますか？")) {
            localStorage.removeItem(STORAGE_KEY);
            location.reload();
          }
        }

        // ========================================
        // トースト通知
        // ========================================
        function showToast(message, isError = false) {
          const toast = document.getElementById("toast");
          toast.textContent = message;
          toast.className = "toast" + (isError ? " error" : "");
          toast.classList.add("show");
          setTimeout(() => toast.classList.remove("show"), 3000);
        }

        // ========================================
        // ウィンドウリサイズ対応
        // ========================================
        window.addEventListener("resize", () => {
          if (appData.records.length > 0) {
            updateChart();
          }
        });
        // ========================================
        // お気に入り条件
        // ========================================
        appData.savedFilters = [];

        function loadSavedFilters() {
          const saved = localStorage.getItem("crowdlog_saved_filters");
          if (saved) {
            try {
              const parsed = JSON.parse(saved);
              if (Array.isArray(parsed)) {
                appData.savedFilters = parsed;
              } else {
                appData.savedFilters = [];
              }
            } catch (e) {
              console.error("JSON parse error", e);
              appData.savedFilters = [];
            }
          } else {
            appData.savedFilters = [];
          }
          updateSavedFiltersSelect();
        }

        function saveSavedFilters() {
          localStorage.setItem(
            "crowdlog_saved_filters",
            JSON.stringify(appData.savedFilters)
          );
          updateSavedFiltersSelect();
        }

        function updateSavedFiltersSelect() {
          const select = document.getElementById("savedFiltersSelect");
          if (!select) return;
          const currentVal = select.value;
          // 安全にオプションを構築
          select.innerHTML = "";
          const defaultOpt = document.createElement("option");
          defaultOpt.value = "";
          defaultOpt.textContent = "(選択してください)";
          select.appendChild(defaultOpt);
          appData.savedFilters.forEach((f) => {
            const opt = document.createElement("option");
            opt.value = f.id;
            opt.textContent = f.name;
            select.appendChild(opt);
          });

          if (appData.savedFilters.some((f) => f.id === currentVal)) {
            select.value = currentVal;
            enableFilterButtons(true);
          } else {
            select.value = "";
            enableFilterButtons(false);
          }
        }

        function enableFilterButtons(enabled) {
          const ids = [
            "btnOverwriteFilter",
            "btnCopyFilter",
            "btnRenameFilter",
            "btnDeleteFilter",
          ];
          ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = !enabled;
          });
        }

        function saveCurrentFilter() {
          const name = prompt("保存する名前を入力してください:", "現在の条件");
          if (!name) return;

          const newFilter = {
            id: Date.now().toString(),
            name: name,
            filters: {
              projects: [...filters.projects],
              departments: [...filters.departments],
              employees: [...filters.employees],
            },
          };
          appData.savedFilters.push(newFilter);
          saveSavedFilters();

          document.getElementById("savedFiltersSelect").value = newFilter.id;
          enableFilterButtons(true);
        }

        function overwriteCurrentFilter() {
          const select = document.getElementById("savedFiltersSelect");
          const id = select.value;
          if (!id || !confirm("現在選択中のフィルター設定を上書きしますか？"))
            return;

          const index = appData.savedFilters.findIndex((f) => f.id === id);
          if (index > -1) {
            appData.savedFilters[index].filters = {
              projects: [...filters.projects],
              departments: [...filters.departments],
              employees: [...filters.employees],
            };
            saveSavedFilters();
            select.value = id;
            alert("上書き保存しました。");
          }
        }

        function copyCurrentFilter() {
          const select = document.getElementById("savedFiltersSelect");
          const id = select.value;
          if (!id) return;

          const original = appData.savedFilters.find((f) => f.id === id);
          if (!original) return;

          const name = prompt(
            "新しい名前を入力してください:",
            original.name + " のコピー"
          );
          if (!name) return;

          const newFilter = {
            id: Date.now().toString(),
            name: name,
            filters: JSON.parse(JSON.stringify(original.filters)),
          };
          appData.savedFilters.push(newFilter);
          saveSavedFilters();

          document.getElementById("savedFiltersSelect").value = newFilter.id;
          enableFilterButtons(true);
        }

        function renameCurrentFilter() {
          const select = document.getElementById("savedFiltersSelect");
          const id = select.value;
          if (!id) return;

          const target = appData.savedFilters.find((f) => f.id === id);
          if (!target) return;

          const name = prompt("新しい名前を入力してください:", target.name);
          if (!name) return;

          target.name = name;
          saveSavedFilters();
          select.value = id;
        }

        function deleteCurrentFilter() {
          const select = document.getElementById("savedFiltersSelect");
          const id = select.value;
          if (!id || !confirm("本当に削除しますか？")) return;

          appData.savedFilters = appData.savedFilters.filter(
            (f) => f.id !== id
          );
          saveSavedFilters();
        }

        function applySavedFilter(id) {
          if (!id) {
            enableFilterButtons(false);
            return;
          }
          const target = appData.savedFilters.find((f) => f.id === id);
          if (target) {
            filters.projects = [...target.filters.projects];
            filters.departments = [...target.filters.departments];
            filters.employees = [...target.filters.employees];
            updateFiltersUI();
            updateChart();
            enableFilterButtons(true);
            // 選択順を現在状態として永続化
            persistCurrentFilters();
          }
        }
        // エクスポート: インラインハンドラや外部から必要な関数のみグローバルに公開
        try {
          window.CrowdLog = {
            processFile,
            clearData,
            resetPeriod,
            selectAll,
            deselectAll,
            updateFilterSort,
            saveCurrentFilter,
            overwriteCurrentFilter,
            copyCurrentFilter,
            renameCurrentFilter,
            deleteCurrentFilter,
            applySavedFilter,
            loadSavedFilters,
            saveSavedFilters,
            saveToStorage,
            loadFromStorage,
            toggleFilter,
            updatePeriodFilter,
          };
          Object.assign(window, window.CrowdLog);
        } catch (e) {
          console.warn("Export failed", e);
        }
      })();
