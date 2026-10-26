
"use strict";

/* =====================================================
   ADMIN DASHBOARD — KHO TÀI LIỆU / KHO QUIZ
   - Không tự động gọi API theo chu kỳ.
   - Thời gian hiển thị cập nhật tại máy khách.
   - Tương thích HTML Admin mới.
===================================================== */

/* ==================== CẤU HÌNH ==================== */

const DEFAULT_WORKER =
    "https://api-tai-lieu.abcd1601ab.workers.dev";

const DEFAULT_GAS =
    "https://script.google.com/macros/s/AKfycbyq2uML6wFa2isEX5BLffLjXKxMKVeT0EpdAKk0v4oJJinsTpEVvEtLRzZ0R3ZPtLMY/exec";

const STORAGE_KEYS = {
    worker: "admin_worker_url",
    gas: "admin_gas_url",
    key: "admin_key",
    deviceId: "kho_tai_lieu_device_id_v1"
};

let config = {
    worker: localStorage.getItem(STORAGE_KEYS.worker) || DEFAULT_WORKER,
    gas: localStorage.getItem(STORAGE_KEYS.gas) || DEFAULT_GAS,
    key: localStorage.getItem(STORAGE_KEYS.key) || ""
};

let files = [];
let quizzes = [];
let devices = [];

let modalState = null;
let loadingAll = false;
let loadingDevices = false;
let deviceLoadTime = null;

const $ = id => document.getElementById(id);

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
}[char]));

function val(object, ...keys) {
    for (const key of keys) {
        if (
            object?.[key] !== undefined &&
            object[key] !== null &&
            object[key] !== ""
        ) {
            return object[key];
        }
    }

    return "";
}

function deviceIdForError() {
    return (
        localStorage.getItem(STORAGE_KEYS.deviceId) ||
        localStorage.getItem("deviceId") ||
        "Không tìm thấy deviceId trong localStorage"
    );
}

function errorWithDeviceId(message) {
    return String(message || "Lỗi không xác định") +
        "\n\nDevice ID: " + deviceIdForError();
}

/* ==================== THÔNG BÁO ==================== */

function showNotice(message, type = "info") {
    const notice = $("notice");
    if (!notice) return;

    const title = notice.querySelector(".notice-title");
    const content = notice.querySelector(".notice-message");
    const icon = notice.querySelector(".notice-icon i");

    if (title) {
        title.textContent = ({
            success: "Thành công",
            error: "Có lỗi xảy ra",
            info: "Thông báo",
            warning: "Cần chú ý"
        })[type] || "Thông báo";
    }

    if (content) {
        content.textContent = message;
    } else {
        notice.textContent = message;
    }

    if (icon) {
        icon.className = ({
            success: "fa-solid fa-circle-check",
            error: "fa-solid fa-circle-exclamation",
            warning: "fa-solid fa-triangle-exclamation",
            info: "fa-solid fa-circle-info"
        })[type] || "fa-solid fa-circle-info";
    }

    notice.className = "notice show " + type;

    clearTimeout(showNotice.timer);

    showNotice.timer = setTimeout(() => {
        notice.classList.remove("show", "active");
    }, 6500);
}

/* ==================== ĐIỀU HƯỚNG ==================== */

function toggleSidebar(open) {
    $("sidebar")?.classList.toggle("open", Boolean(open));
    $("shade")?.classList.toggle("show", Boolean(open));
}

function navigate(page) {
    document.querySelectorAll(".page-section").forEach(section => {
        section.classList.toggle("active", section.id === "page-" + page);
    });

    document.querySelectorAll(".sidebar-nav .nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.page === page);
    });

    const titles = {
        dashboard: "Tổng quan",
        files: "Quản lý tài liệu",
        quizzes: "Quản lý Quiz",
        devices: "Quản lý thiết bị",
        settings: "Cài đặt API"
    };

    if ($("pageTitle")) {
        $("pageTitle").textContent = titles[page] || "Quản trị";
    }

    toggleSidebar(false);

    /*
     * Không tự gọi API khi chuyển trang.
     * Chỉ render dữ liệu đã tải trong bộ nhớ.
     */
    if (page === "files") renderFiles();
    if (page === "quizzes") renderQuizzes();
    if (page === "devices") renderDevices();
    if (page === "dashboard") {
        renderStats();
        renderRecent();
    }
}

/* ==================== CÀI ĐẶT ==================== */

function initSettings() {
    if ($("workerUrl")) $("workerUrl").value = config.worker;
    if ($("gasUrl")) $("gasUrl").value = config.gas;
    if ($("adminKey")) $("adminKey").value = config.key;
}

function saveSettings() {
    const workerInput = $("workerUrl")?.value.trim();
    const gasInput = $("gasUrl")?.value.trim();
    const keyInput = $("adminKey")?.value.trim();

    config.worker = (workerInput || DEFAULT_WORKER).replace(/\/+$/, "");
    config.gas = gasInput || DEFAULT_GAS;
    config.key = keyInput || "";

    try {
        new URL(config.worker);
        new URL(config.gas);
    } catch {
        showNotice("Worker URL hoặc Apps Script URL không hợp lệ.", "error");
        return;
    }

    localStorage.setItem(STORAGE_KEYS.worker, config.worker);
    localStorage.setItem(STORAGE_KEYS.gas, config.gas);
    localStorage.setItem(STORAGE_KEYS.key, config.key);

    showNotice("Đã lưu cấu hình trên trình duyệt này.", "success");

    // Chỉ gọi API khi người dùng chủ động lưu cấu hình.
    loadAll();
}

/* ==================== GỌI API ==================== */

async function request(url, timeout = 15000) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, timeout);

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                Accept: "application/json"
            }
        });

        const text = await response.text();
        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(
                "API không trả JSON hợp lệ. Kiểm tra URL, quyền triển khai " +
                "và phản hồi Apps Script."
            );
        }

        if (!response.ok) {
            throw new Error(
                data.message ||
                data.error ||
                "HTTP " + response.status
            );
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("API phản hồi quá thời gian chờ.");
        }

        if (error instanceof TypeError) {
            throw new Error(
                "Không thể kết nối API. Kiểm tra mạng, URL và quyền truy cập."
            );
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function dataArray(data) {
    if (Array.isArray(data)) return data;

    for (const key of ["data", "items", "files", "quizzes", "devices"]) {
        if (Array.isArray(data?.[key])) return data[key];
    }

    return [];
}

async function fetchEndpoint(action) {
    if (!config.gas) {
        throw new Error("Chưa cấu hình Apps Script URL.");
    }

    const url = new URL(config.gas);
    url.searchParams.set("action", action);
    url.searchParams.set("_", String(Date.now()));

    if (config.key) {
        url.searchParams.set("adminKey", config.key);
    } else {
        url.searchParams.delete("adminKey");
    }

    const result = await request(url.toString());

    if (result?.success === false || result?.ok === false) {
        throw new Error(
            result.message ||
            result.error ||
            "API từ chối yêu cầu quản trị."
        );
    }

    return result;
}

function setConnectionText(message) {
    if ($("connectionText")) {
        $("connectionText").textContent = message;
    }
}

/* ==================== TẢI DỮ LIỆU ==================== */

async function loadAll() {
    if (loadingAll) return;

    loadingAll = true;
    setConnectionText("Đang kết nối API...");

    showNotice("Đang tải dữ liệu quản trị...", "info");

    const results = await Promise.allSettled([
        fetchEndpoint("admin_files"),
        fetchEndpoint("admin_quizzes"),
        fetchEndpoint("admin_devices")
    ]);

    let successCount = 0;
    const errors = [];

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            successCount++;

            const list = dataArray(result.value);

            if (index === 0) files = list;
            if (index === 1) quizzes = list;

            if (index === 2) {
                devices = list;
                deviceLoadTime = Date.now();
            }
        } else {
            errors.push(result.reason?.message || "Lỗi không xác định");
            console.error("Admin API lỗi:", result.reason);
        }
    });

    loadingAll = false;

    setConnectionText(
        successCount > 0
            ? "Đã nhận dữ liệu " + successCount + "/3 API"
            : "Chưa kết nối được Admin API"
    );

    renderAll();

    if (successCount === 3) {
        showNotice("Đã tải dữ liệu từ cả 3 API quản trị.", "success");
    } else if (successCount > 0) {
        showNotice(
            "Đã tải một phần dữ liệu (" + successCount + "/3).\n" +
            errorWithDeviceId(errors[0] || "Một số API chưa phản hồi."),
            "warning"
        );
    } else {
        showNotice(
            "Không tải được dữ liệu quản trị.\n" +
            errorWithDeviceId(errors[0] || "Kiểm tra cấu hình API."),
            "error"
        );
    }
}

/*
 * Hàm này chỉ chạy khi người dùng chủ động tải lại thiết bị
 * hoặc sau một thao tác quản trị thành công.
 *
 * Không có setInterval gọi API.
 */
async function loadDevices() {
    if (loadingDevices) return;

    loadingDevices = true;

    try {
        const result = await fetchEndpoint("admin_devices");

        devices = dataArray(result);
        deviceLoadTime = Date.now();

        renderDevices();
        renderStats();
        renderRecent();

        setConnectionText("Đã cập nhật thiết bị");
    } catch (error) {
        showNotice(
            "Không tải được thiết bị.\n" + errorWithDeviceId(error.message),
            "error"
        );
    } finally {
        loadingDevices = false;
    }
}

function refreshCurrent() {
    const activePage = document.querySelector(".page-section.active")?.id;

    if (activePage === "page-devices") {
        loadDevices();
    } else {
        loadAll();
    }
}

function renderAll() {
    renderFiles();
    renderQuizzes();
    renderDevices();
    renderStats();
    renderRecent();
}

/* ==================== THỐNG KÊ ==================== */

function renderStats() {
    if ($("statFiles")) $("statFiles").textContent = files.length;
    if ($("statQuizzes")) $("statQuizzes").textContent = quizzes.length;

    if ($("statActive")) {
        $("statActive").textContent = devices.filter(device =>
            normalizeStatus(device.status) === "active"
        ).length;
    }

    if ($("statLocked")) {
        $("statLocked").textContent = devices.filter(device =>
            normalizeStatus(device.status) === "locked"
        ).length;
    }
}

function normalizeStatus(status) {
    const value = String(status || "").trim().toLowerCase();

    if (["active", "enabled", "unlocked", "đang hoạt động"].includes(value)) {
        return "active";
    }

    if (["locked", "blocked", "đã khóa"].includes(value)) {
        return "locked";
    }

    if (["expired", "hết hạn"].includes(value)) {
        return "expired";
    }

    if (["inactive", "disabled", "đang tắt"].includes(value)) {
        return "inactive";
    }

    return value || "unknown";
}

function statusBadge(status) {
    const normalized = normalizeStatus(status);

    const className = ({
        active: "active",
        open: "active",
        locked: "locked",
        closed: "locked",
        inactive: "locked",
        expired: "pending",
        upcoming: "pending",
        pending: "pending"
    })[normalized] || "neutral";

    const labels = {
        active: "Đang hoạt động",
        locked: "Đã khóa",
        expired: "Hết hạn",
        open: "Đang mở",
        upcoming: "Chưa mở",
        closed: "Đã đóng",
        inactive: "Không hoạt động",
        pending: "Đang chờ",
        unknown: "Không rõ"
    };

    return `<span class="badge ${className}">${
        esc(labels[normalized] || status || "Không rõ")
    }</span>`;
}

/* ==================== TÀI LIỆU ==================== */

function renderFiles() {
    if (!$("filesBody")) return;

    const query = ($("fileSearch")?.value || "").trim().toLowerCase();
    const status = $("fileStatus")?.value || "";

    const rows = files.filter(file => {
        const matchesQuery = JSON.stringify(file).toLowerCase().includes(query);

        const activeValue = String(
            val(file, "isActive", "active", "status")
        ).toLowerCase();

        const inactive = [
            "false", "0", "no", "inactive", "disabled", "locked"
        ].includes(activeValue);

        const matchesStatus =
            !status ||
            (status === "active" && !inactive) ||
            (status === "inactive" && inactive);

        return matchesQuery && matchesStatus;
    });

    $("filesBody").innerHTML = rows.length
        ? rows.map(file => {
            const id = val(file, "id", "fileId");
            const name = val(file, "name", "title", "fileName") || "Chưa có tên";
            const category = val(file, "folder", "category", "type") || "—";

            const activeValue = String(
                val(file, "isActive", "active", "status")
            ).toLowerCase();

            const inactive = [
                "false", "0", "no", "inactive", "disabled", "locked"
            ].includes(activeValue);

            return `
                <tr>
                    <td>
                        <strong>${esc(name)}</strong>
                        <div class="sub">${esc(val(file, "description", "desc"))}</div>
                    </td>
                    <td>${esc(id || "—")}</td>
                    <td>${esc(category)}</td>
                    <td>${statusBadge(inactive ? "inactive" : "active")}</td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                onclick="viewItem('file', ${JSON.stringify(String(id))})">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                            <button class="mini" type="button"
                                title="Sao chép ID"
                                onclick="copyText(${JSON.stringify(String(id))})">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-regular fa-folder-open"></i>
            ${files.length ? "Không tìm thấy tài liệu phù hợp." : "Chưa có dữ liệu tài liệu."}
        </td></tr>`;

    if ($("filesCount")) {
        $("filesCount").textContent = `${rows.length} / ${files.length}`;
    }
}

/* ==================== QUIZ ==================== */

function quizState(quiz) {
    const rawStatus = String(val(quiz, "status", "state")).toLowerCase();

    if (["open", "active"].includes(rawStatus)) return "active";
    if (["upcoming", "pending"].includes(rawStatus)) return "upcoming";
    if (["closed", "inactive"].includes(rawStatus)) return "closed";

    const start = Date.parse(
        val(quiz, "startTime", "start", "startDate") || ""
    ) || 0;

    const end = Date.parse(
        val(quiz, "endTime", "end", "endDate") || ""
    ) || 0;

    const now = Date.now();

    if (start && now < start) return "upcoming";
    if (end && now > end) return "closed";

    return "active";
}

function renderQuizzes() {
    if (!$("quizzesBody")) return;

    const query = ($("quizSearch")?.value || "").trim().toLowerCase();
    const status = $("quizStatus")?.value || "";

    const rows = quizzes.filter(quiz => {
        const matchesQuery = JSON.stringify(quiz).toLowerCase().includes(query);
        const state = quizState(quiz);

        const matchesStatus =
            !status ||
            (status === "active" && state === "active") ||
            (status === "upcoming" && state === "upcoming") ||
            (status === "closed" && state === "closed");

        return matchesQuery && matchesStatus;
    });

    $("quizzesBody").innerHTML = rows.length
        ? rows.map(quiz => {
            const id = val(quiz, "id", "code");
            const code = val(quiz, "code", "quizCode", "gc") || "—";
            const name = val(quiz, "name", "title") || "Chưa có tên";
            const count = val(quiz, "questionCount", "questionsCount", "totalQuestions", "count");
            const state = quizState(quiz);

            return `
                <tr>
                    <td>
                        <strong>${esc(name)}</strong>
                        <div class="sub">${esc(val(quiz, "desc", "description"))}</div>
                    </td>
                    <td><strong>${esc(code)}</strong></td>
                    <td>${esc(count || "—")}</td>
                    <td>${statusBadge(state)}</td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                onclick="viewItem('quiz', ${JSON.stringify(String(id))})">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                            <button class="mini" type="button"
                                title="Sao chép mã"
                                onclick="copyText(${JSON.stringify(String(code))})">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-solid fa-graduation-cap"></i>
            ${quizzes.length ? "Không tìm thấy Quiz phù hợp." : "Chưa có dữ liệu Quiz."}
        </td></tr>`;

    if ($("quizzesCount")) {
        $("quizzesCount").textContent = `${rows.length} / ${quizzes.length}`;
    }
}

/* ==================== THIẾT BỊ ==================== */

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return new Intl.DateTimeFormat("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(date);
}

function relativeTime(value) {
    if (!value) return "Chưa có dữ liệu";

    const date = new Date(value);
    const timestamp = date.getTime();

    if (Number.isNaN(timestamp)) return String(value);

    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

    if (seconds < 5) return "Vừa xong";
    if (seconds < 60) return seconds + " giây trước";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " phút trước";

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " giờ trước";

    const days = Math.floor(hours / 24);
    if (days < 30) return days + " ngày trước";

    return formatDate(value);
}

function renderDevices() {
    if (!$("devicesBody")) return;

    const query = ($("deviceSearch")?.value || "").trim().toLowerCase();
    const status = ($("deviceStatus")?.value || "").toLowerCase();

    const rows = devices.filter(device => {
        const matchesQuery = JSON.stringify(device).toLowerCase().includes(query);
        const state = normalizeStatus(val(device, "status", "state"));

        const matchesStatus =
            !status ||
            (status === "active" && state === "active") ||
            (status === "locked" && state === "locked") ||
            (status === "expired" && state === "expired");

        return matchesQuery && matchesStatus;
    });

    $("devicesBody").innerHTML = rows.length
        ? rows.map(device => {
            const id = val(device, "deviceId", "id") || "";
            const ip = val(device, "ip", "lastIP", "ipAddress") || "—";
            const state = normalizeStatus(val(device, "status", "state"));
            const lastSeen = val(device, "lastSeen", "updatedAt", "lastActive");

            const locked = state === "locked";

            return `
                <tr>
                    <td>
                        <strong>${esc(id || "—")}</strong>
                        <div class="sub">Tạo: ${esc(formatDate(val(device, "createdAt", "created_at")))}</div>
                    </td>
                    <td>${esc(ip)}</td>
                    <td>${statusBadge(state)}</td>
                    <td>
                        <span data-live-time="${esc(lastSeen)}"
                              title="${esc(formatDate(lastSeen))}">
                            ${esc(relativeTime(lastSeen))}
                        </span>
                    </td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                onclick="viewItem('device', ${JSON.stringify(String(id))})">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                            <button class="mini" type="button"
                                title="Sao chép Device ID"
                                onclick="copyText(${JSON.stringify(String(id))})">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                            <button class="mini" type="button"
                                title="${locked ? "Mở khóa" : "Khóa"} thiết bị"
                                onclick="${locked ? "confirmUnlock" : "confirmLock"}(${JSON.stringify(String(id))})">
                                <i class="fa-solid ${locked ? "fa-lock-open" : "fa-lock"}"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-solid fa-mobile-screen-button"></i>
            ${devices.length ? "Không tìm thấy thiết bị phù hợp." : "Chưa có dữ liệu thiết bị."}
        </td></tr>`;

    if ($("devicesCount")) {
        $("devicesCount").textContent = `${rows.length} / ${devices.length}`;
    }
}

function renderRecent() {
    if (!$("recentBody")) return;

    const recent = [...devices]
        .sort((a, b) => {
            const aTime = Date.parse(val(a, "lastSeen", "updatedAt")) || 0;
            const bTime = Date.parse(val(b, "lastSeen", "updatedAt")) || 0;
            return bTime - aTime;
        })
        .slice(0, 5);

    $("recentBody").innerHTML = recent.length
        ? recent.map(device => `
            <tr>
                <td><strong>${esc(val(device, "deviceId", "id") || "—")}</strong></td>
                <td>${esc(val(device, "ip", "lastIP") || "—")}</td>
                <td>${statusBadge(val(device, "status"))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="3" class="empty-cell">Chưa có hoạt động để hiển thị.</td></tr>`;
}

/*
 * Chỉ cập nhật nội dung hiển thị từ dữ liệu đã có.
 * Không fetch, không gọi API.
 */
function updateLiveTimes() {
    document.querySelectorAll("[data-live-time]").forEach(element => {
        const value = element.getAttribute("data-live-time");

        element.textContent = relativeTime(value);
        element.title = formatDate(value);
    });
}

/* ==================== MODAL ==================== */

function openModal(title, body, primary = "Xác nhận", action = null) {
    modalState = action;

    if ($("modalTitle")) $("modalTitle").textContent = title;
    if ($("modalBody")) $("modalBody").innerHTML = body;

    if ($("modalPrimary")) {
        $("modalPrimary").innerHTML = `<i class="fa-solid fa-check"></i> ${esc(primary)}`;
        $("modalPrimary").style.display = action ? "inline-flex" : "none";
    }

    $("modalBackdrop")?.classList.add("show");
    $("modalBackdrop")?.setAttribute("aria-hidden", "false");
}

function closeModal() {
    $("modalBackdrop")?.classList.remove("show");
    $("modalBackdrop")?.setAttribute("aria-hidden", "true");
    modalState = null;
}

async function modalAction() {
    if (typeof modalState !== "function") return;

    const action = modalState;

    if ($("modalPrimary")) {
        $("modalPrimary").disabled = true;
    }

    try {
        await action();
    } finally {
        if ($("modalPrimary")) {
            $("modalPrimary").disabled = false;
        }
    }
}

function viewItem(type, id) {
    const list = type === "file"
        ? files
        : type === "quiz"
            ? quizzes
            : devices;

    const item = list.find(value => {
        const itemId = type === "device"
            ? val(value, "deviceId", "id")
            : type === "quiz"
                ? val(value, "id", "code")
                : val(value, "id", "fileId");

        return String(itemId) === String(id);
    });

    if (!item) {
        showNotice("Không tìm thấy dữ liệu cần xem.", "error");
        return;
    }

    const body = Object.entries(item)
        .filter(([key]) => !key.toLowerCase().includes("token"))
        .map(([key, value]) => `
            <div style="padding:10px 0;border-bottom:1px solid #edf0f5">
                <div style="font-size:10px;color:#8a94a8;margin-bottom:4px">
                    ${esc(key)}
                </div>
                <div style="font-size:12px;overflow-wrap:anywhere">
                    ${esc(typeof value === "object" ? JSON.stringify(value) : value)}
                </div>
            </div>
        `).join("");

    openModal(
        "Chi tiết " + ({
            file: "tài liệu",
            quiz: "Quiz",
            device: "thiết bị"
        }[type]),
        body,
        "Đóng",
        null
    );
}

/* ==================== API THAO TÁC ADMIN ==================== */

async function adminAction(action, data = {}) {
    const url = new URL(config.gas);

    url.searchParams.set("action", "admin_" + action);
    url.searchParams.set("_", String(Date.now()));

    for (const [key, value] of Object.entries(data)) {
        url.searchParams.set(key, String(value ?? ""));
    }

    if (config.key) {
        url.searchParams.set("adminKey", config.key);
    }

    const result = await request(url.toString());

    if (result?.success === false || result?.ok === false) {
        throw new Error(result.message || result.error || "Thao tác thất bại.");
    }

    return result;
}

function confirmLock(id) {
    openModal(
        "Khóa thiết bị?",
        `<p>Em có chắc muốn khóa thiết bị <strong>${esc(id)}</strong> không?</p>`,
        "Khóa thiết bị",
        async () => {
            try {
                await adminAction("lock_device", { deviceId: id });
                closeModal();
                showNotice("Đã gửi yêu cầu khóa thiết bị.", "success");
                await loadDevices();
            } catch (error) {
                showNotice(
                    "Không khóa được thiết bị.\n" + errorWithDeviceId(error.message),
                    "error"
                );
            }
        }
    );
}

function confirmUnlock(id) {
    openModal(
        "Mở khóa thiết bị?",
        `<p>Em có chắc muốn mở khóa thiết bị <strong>${esc(id)}</strong> không?</p>`,
        "Mở khóa",
        async () => {
            try {
                await adminAction("unlock_device", { deviceId: id });
                closeModal();
                showNotice("Đã gửi yêu cầu mở khóa thiết bị.", "success");
                await loadDevices();
            } catch (error) {
                showNotice(
                    "Không mở khóa được thiết bị.\n" + errorWithDeviceId(error.message),
                    "error"
                );
            }
        }
    );
}

function confirmDeleteDevice(id) {
    openModal(
        "Xóa thiết bị?",
        `<p>Em sắp xóa thiết bị <strong>${esc(id)}</strong>. Thao tác này có thể không hoàn tác được.</p>`,
        "Xóa thiết bị",
        async () => {
            try {
                await adminAction("delete_device", { deviceId: id });
                closeModal();
                showNotice("Đã gửi yêu cầu xóa thiết bị.", "success");
                await loadDevices();
            } catch (error) {
                showNotice(
                    "Không xóa được thiết bị.\n" + errorWithDeviceId(error.message),
                    "error"
                );
            }
        }
    );
}

/* ==================== THÊM TÀI LIỆU / QUIZ ==================== */

function openItemModal(type) {
    const isFile = type === "file";

    openModal(
        isFile ? "Thêm tài liệu" : "Thêm Quiz",
        `
            <div class="form-group">
                <label for="newName">Tên ${isFile ? "tài liệu" : "Quiz"}</label>
                <input id="newName" type="text" placeholder="Nhập tên..." />
            </div>
            <div class="form-group">
                <label for="newCode">${isFile ? "ID tài liệu" : "Mã tham gia Quiz"}</label>
                <input id="newCode" type="text" placeholder="Nhập ID hoặc mã..." />
            </div>
        `,
        "Gửi yêu cầu",
        async () => {
            const name = $("newName")?.value.trim() || "";
            const code = $("newCode")?.value.trim() || "";

            if (!name || !code) {
                showNotice("Em hãy nhập đủ tên và ID/mã.", "error");
                return;
            }

            try {
                await adminAction(
                    isFile ? "add_file" : "add_quiz",
                    {
                        name,
                        id: isFile ? code : "",
                        code: isFile ? "" : code
                    }
                );

                closeModal();
                showNotice("Đã gửi yêu cầu thêm dữ liệu.", "success");
                await loadAll();
            } catch (error) {
                showNotice(
                    "Không thêm được dữ liệu.\n" + errorWithDeviceId(error.message),
                    "error"
                );
            }
        }
    );
}

/* ==================== SAO CHÉP ==================== */

async function copyText(value) {
    if (!value) {
        showNotice("Không có nội dung để sao chép.", "info");
        return;
    }

    try {
        await navigator.clipboard.writeText(String(value));
        showNotice("Đã sao chép.", "success");
    } catch {
        const textarea = document.createElement("textarea");
        textarea.value = String(value);
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";

        document.body.appendChild(textarea);
        textarea.select();

        const copied = document.execCommand("copy");
        textarea.remove();

        showNotice(
            copied ? "Đã sao chép." : "Không thể sao chép tự động.",
            copied ? "success" : "error"
        );
    }
}

/* ==================== KHỞI TẠO ==================== */

function bindFilters() {
    $("fileSearch")?.addEventListener("input", renderFiles);
    $("fileStatus")?.addEventListener("change", renderFiles);

    $("quizSearch")?.addEventListener("input", renderQuizzes);
    $("quizStatus")?.addEventListener("change", renderQuizzes);

    $("deviceSearch")?.addEventListener("input", renderDevices);
    $("deviceStatus")?.addEventListener("change", renderDevices);

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeModal();
    });
}

initSettings();
bindFilters();
renderAll();

/*
 * Chỉ gọi API khi mở trang lần đầu.
 * Không tạo vòng lặp gọi API.
 */
loadAll();

/*
 * Cập nhật thời gian tương đối mỗi giây trên giao diện.
 * Hàm này KHÔNG gọi API và KHÔNG tải lại danh sách thiết bị.
 */
setInterval(updateLiveTimes, 1000);
