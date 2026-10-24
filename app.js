"use strict";

/* ======================== CONFIG ======================== */

const CONFIG = {
    API_URL: "https://api-tai-lieu.abcd1601ab.workers.dev/list",
    API_TIMEOUT: 20000,
    AUTO_REFRESH: false,
    STORAGE_VIEW: "kho_tai_lieu_view_v1",
    STORAGE_DEVICE_ID: "kho_tai_lieu_device_id_v1",
    STORAGE_DEVICE_TOKEN: "kho_tai_lieu_device_token_v1"
};

/* ======================== STATE ======================== */

const state = {
    allItems: [],
    currentParentId: "0",
    currentFolder: null,
    navigation: [],
    searchText: "",
    searchMode: false,
    viewMode: loadSavedViewMode(),
    loading: false,
    usingCache: false
};

/* ================= DEVICE AUTHENTICATION =============== */

function getDeviceCredentials() {
    try {
        return {
            deviceId: localStorage.getItem(CONFIG.STORAGE_DEVICE_ID) || "",
            deviceToken: localStorage.getItem(CONFIG.STORAGE_DEVICE_TOKEN) || ""
        };
    } catch (error) {
        console.error("Không thể đọc thông tin thiết bị:", error);
        return { deviceId: "", deviceToken: "" };
    }
}

async function ensureDeviceRegistered(signal) {
    const credentials = getDeviceCredentials();

    let deviceId = String(credentials.deviceId || "").trim();
    let deviceToken = String(credentials.deviceToken || "").trim();

    const workerBase = new URL(CONFIG.API_URL).origin;

    async function callWorker(path, params = {}) {
        const url = new URL(path, workerBase);
        const normalizedPath = String(path).replace(/\/+$/, "");

        if (deviceId) {
            url.searchParams.set("deviceId", deviceId);
        }

        // /check chỉ gửi deviceId, không gửi token.
        if (normalizedPath !== "/check" && deviceToken) {
            url.searchParams.set("deviceToken", deviceToken);
        }

        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                url.searchParams.set(key, String(value));
            }
        });

        url.searchParams.set("_refresh", Date.now().toString());

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal
        });

        let data;

        try {
            data = await response.json();
        } catch {
            throw new Error(
                "Worker không trả về JSON hợp lệ khi gọi " + path + "."
            );
        }

        const code = String(
            data?.code || data?.error || data?.reason || ""
        ).trim().toUpperCase();

        console.log("API " + path + ":", {
            httpStatus: response.status,
            success: data?.success,
            status: data?.status,
            code,
            hasDeviceId: Boolean(findResponseValue(data, [
                "deviceId", "device_id"
            ])),
            hasDeviceToken: Boolean(findResponseValue(data, [
                "deviceToken", "device_token", "token",
                "accessToken", "access_token"
            ]))
        });

        return { response, data, code };
    }

    function throwWorkerError(result, fallback) {
        const error = new Error(
            result.data?.message ||
            result.data?.error_description ||
            fallback
        );

        error.code = result.code;
        throw error;
    }

    // Tìm dữ liệu kể cả khi API bọc JSON trong nhiều lớp.
    function findResponseValue(data, keys) {
        const wanted = new Set(
            keys.map(key => String(key).toLowerCase())
        );

        const queue = [{ value: data, depth: 0 }];
        const seen = new Set();

        while (queue.length) {
            const current = queue.shift();
            const value = current.value;

            if (
                !value ||
                typeof value !== "object" ||
                seen.has(value)
            ) {
                continue;
            }

            seen.add(value);

            for (const [key, child] of Object.entries(value)) {
                if (
                    wanted.has(String(key).toLowerCase()) &&
                    child !== undefined &&
                    child !== null &&
                    String(child).trim() !== ""
                ) {
                    return String(child).trim();
                }
            }

            if (current.depth < 6) {
                for (const child of Object.values(value)) {
                    if (child && typeof child === "object") {
                        queue.push({
                            value: child,
                            depth: current.depth + 1
                        });
                    }
                }
            }
        }

        return "";
    }

    function saveReturnedDeviceId(data) {
        const returnedId = findResponseValue(data, [
            "deviceId",
            "device_id"
        ]);

        if (!returnedId) return false;

        deviceId = returnedId;

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_ID,
                deviceId
            );

            if (
                localStorage.getItem(CONFIG.STORAGE_DEVICE_ID) !== deviceId
            ) {
                throw new Error("Không xác minh được deviceId.");
            }
        } catch (error) {
            console.error("Không thể lưu deviceId:", error);
            throw new Error(
                "Đã nhận deviceId nhưng không thể lưu vào trình duyệt."
            );
        }

        return true;
    }

    function saveReturnedToken(data) {
        const returnedToken = findResponseValue(data, [
            "deviceToken",
            "device_token",
            "token",
            "accessToken",
            "access_token"
        ]);

        if (!returnedToken) {
            console.warn(
                "Phản hồi API không tìm thấy deviceToken:",
                data
            );
            return false;
        }

        deviceToken = returnedToken;

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_TOKEN,
                deviceToken
            );

            const savedToken = localStorage.getItem(
                CONFIG.STORAGE_DEVICE_TOKEN
            );

            if (savedToken !== deviceToken) {
                throw new Error("Không xác minh được deviceToken.");
            }
        } catch (error) {
            console.error("Không thể lưu deviceToken:", error);
            throw new Error(
                "Đã nhận deviceToken nhưng không thể lưu vào trình duyệt."
            );
        }

        console.info("Đã lưu deviceToken thành công.");
        return true;
    }

    // BƯỚC 1: Kiểm tra thiết bị.
    const check = await callWorker("/check");

    saveReturnedDeviceId(check.data);
    saveReturnedToken(check.data);

    const checkSuccess =
        check.response.ok &&
        check.data?.success === true &&
        String(check.data.status || "active").toLowerCase() === "active";

    const deviceExpired = check.code === "DEVICE_EXPIRED";

    const deviceNotRegistered = [
        "DEVICE_UNREGISTERED",
        "DEVICE_NOT_FOUND",
        "DEVICE_ID_MISSING"
    ].includes(check.code);

    // BƯỚC 2: Thiết bị active.
    if (checkSuccess) {
        if (!deviceId) {
            throw new Error(
                "Worker không trả về deviceId sau khi kiểm tra thiết bị."
            );
        }

        // Nếu /check không trả token, gọi /renew để lấy token.
        if (!deviceToken) {
            const renew = await callWorker("/renew");

            if (renew.code === "DEVICE_LOCKED") {
                throwWorkerError(
                    renew,
                    "Thiết bị đã bị khóa và không được phép truy cập."
                );
            }

            if (!renew.response.ok || renew.data?.success !== true) {
                throwWorkerError(
                    renew,
                    "Không thể lấy deviceToken từ API /renew."
                );
            }

            saveReturnedDeviceId(renew.data);
            saveReturnedToken(renew.data);
        }

        if (!deviceToken) {
            throw new Error(
                "API xác nhận thiết bị active nhưng không trả deviceToken."
            );
        }

        return { deviceId, deviceToken };
    }

    // BƯỚC 3: Thiết bị hết hạn thì gia hạn.
    if (deviceExpired) {
        if (!deviceId) {
            throwWorkerError(
                check,
                "Thiếu deviceId để gia hạn thiết bị."
            );
        }

        const renew = await callWorker("/renew");

        if (renew.code === "DEVICE_LOCKED") {
            throwWorkerError(
                renew,
                "Thiết bị đã bị khóa và không được phép truy cập."
            );
        }

        if (!renew.response.ok || renew.data?.success !== true) {
            throwWorkerError(renew, "Không thể gia hạn thiết bị.");
        }

        saveReturnedDeviceId(renew.data);
        saveReturnedToken(renew.data);

        if (!deviceId || !deviceToken) {
            throw new Error(
                "Gia hạn thành công nhưng Worker không trả đủ deviceId/deviceToken."
            );
        }

        return { deviceId, deviceToken };
    }

    // BƯỚC 4: Thiết bị chưa đăng ký thì đăng ký.
    if (deviceNotRegistered) {
        const registration = await callWorker("/register");

        if (
            !registration.response.ok ||
            registration.data?.success !== true
        ) {
            throwWorkerError(
                registration,
                "Đăng ký thiết bị thất bại."
            );
        }

        saveReturnedDeviceId(registration.data);
        saveReturnedToken(registration.data);

        if (!deviceId || !deviceToken) {
            throw new Error(
                "Đăng ký thành công nhưng Worker không trả đủ deviceId/deviceToken."
            );
        }

        return { deviceId, deviceToken };
    }

    if (check.code === "DEVICE_LOCKED") {
        throwWorkerError(
            check,
            "Thiết bị đã bị khóa và không được phép truy cập."
        );
    }

    throwWorkerError(
        check,
        "Không thể xác minh thiết bị. Vui lòng thử lại."
    );
}

/* ============================ DOM ======================= */

const DOM = {
    homeButton: document.getElementById("homeButton"),
    refreshButton: document.getElementById("refreshButton"),
    retryButton: document.getElementById("retryButton"),
    backButton: document.getElementById("backButton"),
    searchInput: document.getElementById("searchInput"),
    clearSearch: document.getElementById("clearSearch"),
    gridViewButton: document.getElementById("gridViewButton"),
    listViewButton: document.getElementById("listViewButton"),
    breadcrumb: document.getElementById("breadcrumb"),
    pageTitle: document.getElementById("pageTitle"),
    pageDescription: document.getElementById("pageDescription"),
    itemCount: document.getElementById("itemCount"),
    itemsContainer: document.getElementById("itemsContainer"),
    loadingState: document.getElementById("loadingState"),
    emptyState: document.getElementById("emptyState"),
    emptyMessage: document.getElementById("emptyMessage"),
    errorState: document.getElementById("errorState"),
    errorMessage: document.getElementById("errorMessage"),
    toast: document.getElementById("toast"),
    toastMessage: document.getElementById("toastMessage")
};

/* ============================ INIT ====================== */

document.addEventListener("DOMContentLoaded", init);

async function init() {
    bindEvents();
    applyViewMode();

    state.allItems = [];
    state.usingCache = false;

    showLoading();
    await loadData(false, false);
}

/* ============================ EVENTS ==================== */

function bindEvents() {
    if (DOM.homeButton) {
        DOM.homeButton.addEventListener("click", function(event) {
            event.preventDefault();
            goHome();
        });
    }

    if (DOM.refreshButton) {
        DOM.refreshButton.addEventListener("click", function() {
            loadData(true, false);
        });
    }

    if (DOM.retryButton) {
        DOM.retryButton.addEventListener("click", function() {
            loadData(true, false);
        });
    }

    if (DOM.backButton) {
        DOM.backButton.addEventListener("click", goBack);
    }

    if (DOM.searchInput) {
        DOM.searchInput.addEventListener("input", function() {
            state.searchText = this.value.trim().toLowerCase();
            state.searchMode = state.searchText.length > 0;
            updateClearSearch();
            renderCurrentFolder();
        });
    }

    if (DOM.clearSearch) {
        DOM.clearSearch.addEventListener("click", function() {
            clearSearch();
            if (DOM.searchInput) DOM.searchInput.focus();
        });
    }

    if (DOM.gridViewButton) {
        DOM.gridViewButton.addEventListener("click", function() {
            state.viewMode = "grid";
            saveViewMode();
            applyViewMode();
            renderCurrentFolder();
        });
    }

    if (DOM.listViewButton) {
        DOM.listViewButton.addEventListener("click", function() {
            state.viewMode = "list";
            saveViewMode();
            applyViewMode();
            renderCurrentFolder();
        });
    }

    window.addEventListener("keydown", function(event) {
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "k"
        ) {
            event.preventDefault();
            if (DOM.searchInput) DOM.searchInput.focus();
        }

        if (event.key === "Escape") {
            if (state.searchText) {
                clearSearch();
                return;
            }

            if (document.activeElement === DOM.searchInput) {
                DOM.searchInput.blur();
            }
        }

        if (
            event.key === "Backspace" &&
            document.activeElement !== DOM.searchInput &&
            !(document.activeElement instanceof HTMLTextAreaElement) &&
            !(document.activeElement instanceof HTMLInputElement)
        ) {
            if (!isRoot()) {
                event.preventDefault();
                goBack();
            }
        }
    });
}

/* ======================== LOAD API DATA ================= */

async function loadData(showToast = false, hasCache = false) {
    if (state.loading) return;

    state.loading = true;
    state.usingCache = false;
    state.allItems = [];
    resetNavigation();

    showLoading();
    hideError();
    hideEmpty();
    setRefreshLoading(true);

    let timeout = null;
    let controller = null;

    try {
        if (!CONFIG.API_URL) {
            throw new Error("Chưa cấu hình API_URL trong app.js.");
        }

        controller = new AbortController();

        timeout = setTimeout(function() {
            controller.abort();
        }, CONFIG.API_TIMEOUT);

        // Xác thực và lưu token trước khi gọi /list.
        await ensureDeviceRegistered(controller.signal);

        const credentials = getDeviceCredentials();
        const deviceId = String(credentials.deviceId || "").trim();
        const deviceToken = String(credentials.deviceToken || "").trim();

        if (!deviceId) {
            throw new Error(
                "Thiếu deviceId sau khi xác thực thiết bị. Vui lòng tải lại trang."
            );
        }

        if (!deviceToken) {
            throw new Error(
                "Thiếu deviceToken sau khi xác thực thiết bị."
            );
        }

        const url = new URL(CONFIG.API_URL);
        url.searchParams.set("deviceId", deviceId);
        url.searchParams.set("deviceToken", deviceToken);
        url.searchParams.set("_refresh", Date.now().toString());

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json",
                "X-Device-Id": deviceId,
                "X-Device-Token": deviceToken
            },
            cache: "no-store",
            signal: controller.signal
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error("API không trả về dữ liệu JSON hợp lệ.");
        }

        const deviceError = String(
            result?.code ||
            result?.error ||
            result?.reason ||
            ""
        );

        if (
            [
                "DEVICE_LOCKED",
                "DEVICE_UNREGISTERED",
                "DEVICE_NOT_FOUND",
                "DEVICE_ID_MISSING",
                "DEVICE_EXPIRED",
                "TOKEN_INVALID",
                "IP_NOT_FOUND",
                "IP_MISSING"
            ].includes(deviceError.toUpperCase())
        ) {
            const error = new Error(
                result?.message ||
                "Thiết bị chưa được xác thực hoặc không được phép truy cập."
            );

            error.code = deviceError;
            throw error;
        }

        if (!response.ok) {
            const error = new Error(
                result?.message || "API trả về HTTP " + response.status
            );

            error.code = deviceError;
            throw error;
        }

        if (result?.success === false) {
            const error = new Error(result.message || "API trả về lỗi.");
            error.code = deviceError;
            throw error;
        }

        const items = normalizeApiData(result);

        if (!Array.isArray(items)) {
            throw new Error("API không trả về danh sách hợp lệ.");
        }

        state.allItems = removeDuplicateIds(items);
        state.usingCache = false;

        resetNavigation();
        hideLoading();
        hideError();
        hideEmpty();
        renderCurrentFolder();

        if (showToast) {
            showToastMessage("Đã cập nhật dữ liệu");
        }
    } catch (error) {
        console.error("API ERROR:", error);

        state.allItems = [];
        state.usingCache = false;

        resetNavigation();
        hideLoading();
        hideEmpty();
        showError(getErrorMessage(error));
    } finally {
        if (timeout !== null) clearTimeout(timeout);

        state.loading = false;
        setRefreshLoading(false);
    }
}

/* ===================== NORMALIZE API DATA =============== */

function normalizeApiData(result) {
    let rawItems = [];

    if (Array.isArray(result)) {
        rawItems = result;
    } else if (result && Array.isArray(result.files)) {
        rawItems = result.files;
    } else if (result && Array.isArray(result.data)) {
        rawItems = result.data;
    } else if (result && Array.isArray(result.items)) {
        rawItems = result.items;
    } else if (result && Array.isArray(result.results)) {
        rawItems = result.results;
    } else if (result && result.data && Array.isArray(result.data.files)) {
        rawItems = result.data.files;
    } else if (result && result.success === false) {
        throw new Error(result.message || "API trả về lỗi.");
    } else {
        throw new Error("Dữ liệu API không đúng định dạng.");
    }

    return rawItems
        .map(normalizeItem)
        .filter(item => item.id !== "");
}

function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") {
        return {
            id: "",
            parentId: "0",
            name: "",
            type: "file",
            description: "",
            size: "",
            updatedAt: "",
            icon: "",
            mimeType: "",
            extension: ""
        };
    }

    const id = String(
        raw.id ?? raw.ID ?? raw.folderId ?? ""
    ).trim();

    const parentRaw =
        raw.parentId ??
        raw.parentID ??
        raw.parent ??
        raw.parent_id ??
        "0";

    const parentText = String(parentRaw).trim();

    const parentId =
        parentText === "" ||
        parentText === "null" ||
        parentText === "undefined"
            ? "0"
            : parentText;

    const name = String(
        raw.name ??
        raw.title ??
        raw.fileName ??
        raw.folderName ??
        raw.ten ??
        "Không có tên"
    ).trim();

    const rawType = String(
        raw.type ??
        raw.kind ??
        raw.category ??
        ""
    ).trim().toLowerCase();

    let type = rawType;

    if (type !== "folder" && type !== "file") {
        const isFolder =
            raw.folder === true ||
            raw.isFolder === true ||
            rawType === "directory" ||
            rawType === "dir" ||
            rawType === "thumuc" ||
            rawType === "muc";

        type = isFolder ? "folder" : "file";
    }

    return {
        id,
        parentId,
        name,
        type,
        description: String(raw.description ?? raw.desc ?? "").trim(),
        size: String(raw.size ?? raw.fileSize ?? "").trim(),
        updatedAt: String(
            raw.updatedAt ?? raw.updated ?? raw.date ?? ""
        ).trim(),
        icon: String(raw.icon ?? "").trim(),
        mimeType: String(raw.mimeType ?? raw.mime ?? "").trim().toLowerCase(),
        extension: String(raw.extension ?? "").trim().toLowerCase()
    };
}

function removeDuplicateIds(items) {
    const map = new Map();

    items.forEach(item => {
        const id = String(item.id);
        if (!map.has(id)) map.set(id, item);
    });

    return Array.from(map.values());
}

/* ======================== NAVIGATION ==================== */

function isRoot() {
    return (
        state.currentParentId === null ||
        state.currentParentId === "" ||
        String(state.currentParentId) === "0"
    );
}

function resetNavigation() {
    state.currentParentId = "0";
    state.currentFolder = null;
    state.navigation = [];
}

function goHome() {
    resetNavigation();
    clearSearch();
    renderCurrentFolder();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

function openFolder(folder) {
    if (!folder) return;

    state.navigation.push({
        id: state.currentParentId,
        folder: state.currentFolder
    });

    state.currentParentId = String(folder.id);
    state.currentFolder = folder;

    clearSearch(false);
    renderCurrentFolder();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

function goBack() {
    if (state.navigation.length === 0) {
        goHome();
        return;
    }

    const previous = state.navigation.pop();

    state.currentParentId =
        previous.id === null || previous.id === undefined
            ? "0"
            : String(previous.id);

    state.currentFolder = previous.folder;

    clearSearch(false);
    renderCurrentFolder();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

function getCurrentItems() {
    const parentId = isRoot() ? "0" : String(state.currentParentId);

    return state.allItems.filter(item => {
        const itemParent =
            item.parentId === null ||
            item.parentId === undefined ||
            String(item.parentId).trim() === ""
                ? "0"
                : String(item.parentId).trim();

        return itemParent === parentId;
    });
}

/* ============================ RENDER ==================== */

function renderCurrentFolder() {
    if (!DOM.itemsContainer) return;

    if (state.searchMode && state.searchText) {
        renderSearchResults();
        return;
    }

    const filtered = sortItems(getCurrentItems());

    renderHeader();
    renderBreadcrumb();
    updateToolbar(filtered.length);

    DOM.itemsContainer.innerHTML = "";

    if (filtered.length === 0) {
        showEmpty("Chưa có file hoặc thư mục nào trong mục này.");
        return;
    }

    hideEmpty();

    filtered.forEach(item => {
        DOM.itemsContainer.appendChild(createItemCard(item));
    });
}

/* ========================= GLOBAL SEARCH ================ */

function renderSearchResults() {
    const results = searchAllItems(state.searchText);

    if (DOM.pageTitle) {
        DOM.pageTitle.textContent = "Kết quả tìm kiếm";
    }

    if (DOM.pageDescription) {
        DOM.pageDescription.textContent =
            "Tìm thấy " + results.length + " kết quả trong toàn bộ kho.";
    }

    renderSearchBreadcrumb();
    updateToolbar(results.length);

    DOM.itemsContainer.innerHTML = "";

    if (results.length === 0) {
        showEmpty("Không tìm thấy file hoặc thư mục phù hợp.");
        return;
    }

    hideEmpty();

    results.forEach(item => {
        DOM.itemsContainer.appendChild(createItemCard(item, true));
    });
}

function searchAllItems(keyword) {
    const normalized = String(keyword).trim().toLowerCase();

    if (!normalized) return [];

    return sortItems(
        state.allItems.filter(item =>
            item.name.toLowerCase().includes(normalized) ||
            item.description.toLowerCase().includes(normalized) ||
            item.type.toLowerCase().includes(normalized) ||
            getExtension(item).includes(normalized)
        )
    );
}

function renderSearchBreadcrumb() {
    if (!DOM.breadcrumb) return;

    DOM.breadcrumb.innerHTML = "";

    const home = document.createElement("button");
    home.type = "button";
    home.className = "breadcrumb-home";
    home.innerHTML = '<i class="fa-solid fa-house"></i> Trang chủ';
    home.addEventListener("click", goHome);

    DOM.breadcrumb.appendChild(home);

    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    DOM.breadcrumb.appendChild(separator);

    const current = document.createElement("span");
    current.className = "breadcrumb-current";
    current.textContent = "Tìm kiếm";

    DOM.breadcrumb.appendChild(current);
}

function sortItems(items) {
    return [...items].sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
        }

        return a.name.localeCompare(b.name, "vi", {
            sensitivity: "base"
        });
    });
}

/* ======================== CREATE CARD =================== */

function createItemCard(item, isSearchResult = false) {
    const card = document.createElement("div");
    card.className = "item-card";

    const iconElement = document.createElement("div");
    iconElement.className = "item-icon " + getIconClass(item);
    iconElement.innerHTML = '<i class="' + getItemIcon(item) + '"></i>';

    const content = document.createElement("div");
    content.className = "item-content";

    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = item.name;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = isSearchResult
        ? getSearchMeta(item)
        : getItemMeta(item);

    content.appendChild(name);

    if (meta.textContent) {
        content.appendChild(meta);
    }

    const arrow = document.createElement("div");
    arrow.className = "item-arrow";
    arrow.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

    card.appendChild(iconElement);
    card.appendChild(content);
    card.appendChild(arrow);

    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");

    card.addEventListener("click", function() {
        handleItemClick(item, isSearchResult);
    });

    card.addEventListener("keydown", function(event) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleItemClick(item, isSearchResult);
        }
    });

    return card;
}

function getSearchMeta(item) {
    const path = getItemPath(item);
    return path || getItemMeta(item);
}

function getItemPath(item) {
    if (!item) return "";

    const path = [];
    let current = item;
    let safety = 0;

    while (current && safety < 100) {
        path.unshift(current.name);

        if (!current.parentId || String(current.parentId) === "0") {
            break;
        }

        const parentId = current.parentId;

        current = state.allItems.find(parent =>
            String(parent.id) === String(parentId)
        );

        safety++;
    }

    return path.join(" / ");
}

/* ========================= HANDLE CLICK ================ */

function handleItemClick(item, fromSearch = false) {
    if (!item) return;

    if (fromSearch) {
        if (item.type === "folder") {
            openFolderFromSearch(item);
            return;
        }

        openFile(item);
        return;
    }

    if (item.type === "folder") {
        openFolder(item);
        return;
    }

    openFile(item);
}

function openFolderFromSearch(folder) {
    if (!folder) return;

    const chain = buildFolderChain(folder);
    state.navigation = [];

    let parentId = "0";

    chain.forEach((currentFolder, index) => {
        state.navigation.push({
            id: parentId,
            folder: index === 0 ? null : chain[index - 1]
        });

        parentId = String(currentFolder.id);
    });

    if (state.navigation.length > 0) {
        state.navigation.pop();
    }

    state.currentFolder = folder;
    state.currentParentId = String(folder.id);

    clearSearch(false);
    renderCurrentFolder();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

function buildFolderChain(item) {
    const chain = [];
    let current = item;
    let safety = 0;

    while (current && safety < 100) {
        chain.unshift(current);

        if (!current.parentId || String(current.parentId) === "0") {
            break;
        }

        const parentId = current.parentId;

        current = state.allItems.find(parent =>
            parent.type === "folder" &&
            String(parent.id) === String(parentId)
        );

        safety++;
    }

    return chain;
}

/* =========================== OPEN FILE ================== */

function openFile(item) {
    if (!item) return;

    const extension = getExtension(item);

    const isPDF =
        extension === "pdf" ||
        item.mimeType === "application/pdf";

    if (isPDF) {
        if (!item.id) {
            showToastMessage("Không xác định được ID tài liệu.");
            return;
        }

        window.location.href =
            "view.html?id=" + encodeURIComponent(item.id);

        return;
    }

    showToastMessage("File này chưa hỗ trợ xem trực tiếp.");
}

/* ============================ ICON ====================== */

function getItemIcon(item) {
    if (item.type === "folder") {
        return "fa-solid fa-folder";
    }

    const extension = getExtension(item);

    if (extension === "pdf") return "fa-solid fa-file-pdf";
    if (["doc", "docx"].includes(extension)) return "fa-solid fa-file-word";
    if (["xls", "xlsx", "csv"].includes(extension)) return "fa-solid fa-file-excel";
    if (["ppt", "pptx"].includes(extension)) return "fa-solid fa-file-powerpoint";

    if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(extension)) {
        return "fa-solid fa-file-image";
    }

    if (["mp4", "mkv", "avi", "mov", "webm"].includes(extension)) {
        return "fa-solid fa-file-video";
    }

    if (["mp3", "wav", "flac", "aac"].includes(extension)) {
        return "fa-solid fa-file-audio";
    }

    if (["zip", "rar", "7z"].includes(extension)) {
        return "fa-solid fa-file-zipper";
    }

    return "fa-solid fa-file";
}

function getIconClass(item) {
    if (item.type === "folder") return "";

    const extension = getExtension(item);

    if (extension === "pdf") return "file-pdf";
    if (["doc", "docx"].includes(extension)) return "file-word";
    if (["xls", "xlsx", "csv"].includes(extension)) return "file-excel";
    if (["ppt", "pptx"].includes(extension)) return "file-powerpoint";

    if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(extension)) {
        return "file-image";
    }

    if (["mp4", "mkv", "avi", "mov", "webm"].includes(extension)) {
        return "file-video";
    }

    if (["mp3", "wav", "flac", "aac"].includes(extension)) {
        return "file-audio";
    }

    if (["zip", "rar", "7z"].includes(extension)) {
        return "file-archive";
    }

    return "";
}

/* ========================== EXTENSION =================== */

function getExtension(item) {
    if (item && item.extension) {
        return item.extension.replace(".", "").toLowerCase();
    }

    if (!item || !item.name || !item.name.includes(".")) {
        return "";
    }

    return item.name.split(".").pop().toLowerCase();
}

/* ============================ META ====================== */

function getItemMeta(item) {
    if (item.type === "folder") {
        const count = state.allItems.filter(child =>
            String(child.parentId) === String(item.id)
        ).length;

        return count + " mục";
    }

    const parts = [];

    if (item.size) parts.push(item.size);
    if (item.updatedAt) parts.push(item.updatedAt);

    if (parts.length === 0) {
        const extension = getExtension(item);
        if (extension) parts.push(extension.toUpperCase());
    }

    return parts.join(" • ");
}

/* ============================ HEADER ==================== */

function renderHeader() {
    if (state.searchMode && state.searchText) return;

    if (state.currentFolder) {
        if (DOM.pageTitle) {
            DOM.pageTitle.textContent = state.currentFolder.name;
        }

        if (DOM.pageDescription) {
            DOM.pageDescription.textContent =
                state.currentFolder.description ||
                "Các file và thư mục trong mục này.";
        }
    } else {
        if (DOM.pageTitle) {
            DOM.pageTitle.textContent = "Kho tài liệu";
        }

        if (DOM.pageDescription) {
            DOM.pageDescription.textContent =
                "Các tài liệu được chia sẻ.";
        }
    }
}

/* ========================= BREADCRUMB =================== */

function renderBreadcrumb() {
    if (!DOM.breadcrumb) return;

    DOM.breadcrumb.innerHTML = "";

    const home = document.createElement("button");
    home.type = "button";
    home.className = "breadcrumb-home";
    home.innerHTML = '<i class="fa-solid fa-house"></i> Trang chủ';
    home.addEventListener("click", goHome);

    DOM.breadcrumb.appendChild(home);

    const folders = state.navigation
        .map(item => item.folder)
        .filter(Boolean);

    if (state.currentFolder) {
        folders.push(state.currentFolder);
    }

    folders.forEach((folder, index) => {
        const separator = document.createElement("span");
        separator.className = "breadcrumb-separator";
        separator.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';

        DOM.breadcrumb.appendChild(separator);

        const isLast = index === folders.length - 1;

        if (isLast) {
            const current = document.createElement("span");
            current.className = "breadcrumb-current";
            current.textContent = folder.name;

            DOM.breadcrumb.appendChild(current);
        } else {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "breadcrumb-home";
            button.textContent = folder.name;

            button.addEventListener("click", function() {
                navigateToBreadcrumb(index);
            });

            DOM.breadcrumb.appendChild(button);
        }
    });
}

function navigateToBreadcrumb(index) {
    const folders = state.navigation
        .map(item => item.folder)
        .filter(Boolean);

    if (index < 0 || index >= folders.length) {
        goHome();
        return;
    }

    const targetFolder = folders[index];
    const newNavigation = [];

    for (let i = 0; i < index; i++) {
        newNavigation.push(state.navigation[i]);
    }

    state.navigation = newNavigation;
    state.currentFolder = targetFolder;
    state.currentParentId = String(targetFolder.id);

    clearSearch(false);
    renderCurrentFolder();

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}

/* ============================ TOOLBAR =================== */

function updateToolbar(count) {
    if (DOM.itemCount) {
        DOM.itemCount.textContent = count + " mục";
    }

    if (!DOM.backButton) return;

    if (isRoot() || state.searchMode) {
        DOM.backButton.classList.add("hidden");
    } else {
        DOM.backButton.classList.remove("hidden");
    }
}

/* =========================== VIEW MODE ================== */

function applyViewMode() {
    if (!DOM.itemsContainer) return;

    if (state.viewMode === "list") {
        DOM.itemsContainer.classList.add("list-view");

        if (DOM.listViewButton) {
            DOM.listViewButton.classList.add("active");
        }

        if (DOM.gridViewButton) {
            DOM.gridViewButton.classList.remove("active");
        }
    } else {
        DOM.itemsContainer.classList.remove("list-view");

        if (DOM.gridViewButton) {
            DOM.gridViewButton.classList.add("active");
        }

        if (DOM.listViewButton) {
            DOM.listViewButton.classList.remove("active");
        }
    }
}

/* ============================ LOADING =================== */

function showLoading() {
    if (DOM.loadingState) {
        DOM.loadingState.classList.remove("hidden");
    }

    if (DOM.errorState) {
        DOM.errorState.classList.add("hidden");
    }

    if (DOM.emptyState) {
        DOM.emptyState.classList.add("hidden");
    }

    if (DOM.itemsContainer) {
        DOM.itemsContainer.innerHTML = "";
    }
}

function hideLoading() {
    if (DOM.loadingState) {
        DOM.loadingState.classList.add("hidden");
    }
}

/* ============================== EMPTY =================== */

function showEmpty(message) {
    if (DOM.emptyMessage) {
        DOM.emptyMessage.textContent = message;
    }

    if (DOM.emptyState) {
        DOM.emptyState.classList.remove("hidden");
    }
}

function hideEmpty() {
    if (DOM.emptyState) {
        DOM.emptyState.classList.add("hidden");
    }
}

/* ============================== ERROR =================== */

function showError(message) {
    if (DOM.errorMessage) {
        DOM.errorMessage.textContent = message;
    }

    if (DOM.errorState) {
        DOM.errorState.classList.remove("hidden");
    }

    if (DOM.itemsContainer) {
        DOM.itemsContainer.innerHTML = "";
    }

    if (DOM.emptyState) {
        DOM.emptyState.classList.add("hidden");
    }
}

function hideError() {
    if (DOM.errorState) {
        DOM.errorState.classList.add("hidden");
    }
}

/* ========================== CLEAR SEARCH ================ */

function clearSearch(render = true) {
    state.searchText = "";
    state.searchMode = false;

    if (DOM.searchInput) {
        DOM.searchInput.value = "";
    }

    updateClearSearch();

    if (render) {
        renderCurrentFolder();
    }
}

function updateClearSearch() {
    if (!DOM.clearSearch) return;

    if (state.searchText) {
        DOM.clearSearch.classList.remove("hidden");
    } else {
        DOM.clearSearch.classList.add("hidden");
    }
}

/* ========================= ERROR MESSAGE ================ */

function getErrorMessage(error) {
    if (error && error.name === "AbortError") {
        return "API không phản hồi.";
    }

    if (error && error.message) {
        return error.message;
    }

    return "Không thể kết nối tới API.";
}

/* ======================== REFRESH BUTTON ================ */

function setRefreshLoading(loading) {
    if (!DOM.refreshButton) return;

    DOM.refreshButton.disabled = loading;

    const icon = DOM.refreshButton.querySelector("i");

    if (icon) {
        if (loading) {
            icon.classList.add("fa-spin");
        } else {
            icon.classList.remove("fa-spin");
        }
    }

    if (DOM.retryButton) {
        DOM.retryButton.disabled = loading;
    }
}

/* ============================== TOAST =================== */

let toastTimer = null;

function showToastMessage(message) {
    if (!DOM.toast || !DOM.toastMessage) return;

    DOM.toastMessage.textContent = message;
    DOM.toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(function() {
        DOM.toast.classList.remove("show");
    }, 3000);
}

/* ========================= LOCAL STORAGE ================ */

function loadSavedViewMode() {
    try {
        const saved = localStorage.getItem(CONFIG.STORAGE_VIEW);
        return saved === "list" ? "list" : "grid";
    } catch (error) {
        return "grid";
    }
}

function saveViewMode() {
    try {
        localStorage.setItem(CONFIG.STORAGE_VIEW, state.viewMode);
    } catch (error) {
        console.warn("Không thể lưu chế độ hiển thị:", error);
    }
}