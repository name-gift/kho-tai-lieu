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
            deviceId:
                localStorage.getItem(CONFIG.STORAGE_DEVICE_ID) || "",

            deviceToken:
                localStorage.getItem(CONFIG.STORAGE_DEVICE_TOKEN) || ""
        };
    } catch (error) {
        console.error(
            "Không thể đọc thông tin thiết bị:",
            error
        );

        return {
            deviceId: "",
            deviceToken: ""
        };
    }
}


/*
 * Quy trình xác thực:
 * 1. /check chỉ gửi deviceId.
 * 2. Nếu thiết bị tồn tại hoặc hết hạn, gọi /renew.
 * 3. Nếu /renew trả token mới, lưu token mới.
 * 4. Nếu chưa đăng ký, gọi /register.
 * 5. Trả về thông tin xác thực mới nhất để /list sử dụng.
 */

async function ensureDeviceRegistered(signal) {
    const credentials = getDeviceCredentials();

    let deviceId = String(
        credentials.deviceId || ""
    ).trim();

    // Phải dùng let vì token có thể được thay mới.
    let deviceToken = String(
        credentials.deviceToken || ""
    ).trim();

    // Chỉ tạo deviceId nếu chưa có.
    if (!deviceId) {
        if (
            typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
        ) {
            deviceId = crypto.randomUUID();
        } else {
            deviceId =
                "device_" +
                Date.now().toString(36) +
                "_" +
                Math.random().toString(36).slice(2) +
                Math.random().toString(36).slice(2);
        }

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_ID,
                deviceId
            );
        } catch (error) {
            throw new Error(
                "Trình duyệt không cho phép lưu thông tin thiết bị."
            );
        }
    }

    const workerBase = new URL(CONFIG.API_URL).origin;

    async function callWorker(path, params = {}) {
        const url = new URL(path, workerBase);

        url.searchParams.set("deviceId", deviceId);

        // /check tuyệt đối không gửi deviceToken.
        // Các API khác vẫn gửi token hiện tại nếu có.
        const normalizedPath = String(path).replace(/\/+$/, "");

        if (
            normalizedPath !== "/check" &&
            deviceToken
        ) {
            url.searchParams.set(
                "deviceToken",
                deviceToken
            );
        }

        Object.entries(params).forEach(function([key, value]) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                url.searchParams.set(
                    key,
                    String(value)
                );
            }
        });

        url.searchParams.set(
            "_refresh",
            Date.now().toString()
        );

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept": "application/json"
            },
            cache: "no-store",
            signal
        });

        let data;

        try {
            data = await response.json();
        } catch {
            throw new Error(
                "Worker không trả về JSON hợp lệ khi gọi " +
                path +
                "."
            );
        }

        const code = String(
            data?.code ||
            data?.error ||
            data?.reason ||
            ""
        ).trim().toUpperCase();

        return {
            response,
            data,
            code
        };
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

    /*
     * Lưu token mới.
     * Hỗ trợ một số cấu trúc JSON phổ biến mà Worker có thể trả về.
     */
    function saveReturnedToken(data) {
        const token = (
            data?.deviceToken ??
            data?.token ??
            data?.data?.deviceToken ??
            data?.data?.token ??
            data?.result?.deviceToken ??
            data?.result?.token
        );

        if (
            token === undefined ||
            token === null ||
            String(token).trim() === ""
        ) {
            return false;
        }

        const newToken = String(token).trim();

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_TOKEN,
                newToken
            );

            // Cập nhật biến để những lần gọi API tiếp theo
            // trong cùng phiên sử dụng token mới.
            deviceToken = newToken;

            return true;
        } catch (error) {
            throw new Error(
                "Đã nhận token mới nhưng không thể lưu vào trình duyệt."
            );
        }
    }

    // BƯỚC 1: /check chỉ gửi deviceId, không gửi token.
    const check = await callWorker("/check");

    const checkSuccess =
        check.response.ok &&
        check.data?.success === true &&
        String(
            check.data.status || "active"
        ).toLowerCase() === "active";

    const deviceExpired =
        check.code === "DEVICE_EXPIRED";

    const deviceNotRegistered = [
        "DEVICE_UNREGISTERED",
        "DEVICE_NOT_FOUND"
    ].includes(check.code);

    // BƯỚC 2: Thiết bị đã tồn tại hoặc hết hạn thì gọi /renew.
    if (checkSuccess || deviceExpired) {
        const renew = await callWorker("/renew");

        if (renew.code === "DEVICE_LOCKED") {
            throwWorkerError(
                renew,
                "Thiết bị đã bị khóa và không được phép truy cập."
            );
        }

        const notExpired =
            renew.code === "DEVICE_NOT_EXPIRED";

        const renewSuccess =
            renew.response.ok &&
            renew.data?.success === true;

        if (!renewSuccess && !notExpired) {
            throwWorkerError(
                renew,
                "Không thể gia hạn hoặc xác minh thiết bị."
            );
        }

        /*
         * Quan trọng:
         * Nếu /renew trả token mới, lưu ngay token mới.
         * Nếu /renew không trả token mới, giữ token đang có.
         */
        saveReturnedToken(renew.data);

        return {
            deviceId,
            deviceToken
        };
    }

    // BƯỚC 3: Chỉ đăng ký nếu thiết bị chưa tồn tại.
    if (deviceNotRegistered) {
        const registration = await callWorker("/register");

        if (
            !registration.response.ok ||
            registration.data?.success !== true
        ) {
            if (registration.code === "DEVICE_LOCKED") {
                throwWorkerError(
                    registration,
                    "Thiết bị đã bị khóa."
                );
            }

            throwWorkerError(
                registration,
                "Đăng ký thiết bị thất bại."
            );
        }

        const returnedDeviceId = String(
            registration.data?.deviceId ||
            registration.data?.data?.deviceId ||
            deviceId
        ).trim();

        if (!returnedDeviceId) {
            throw new Error(
                "Worker không trả về deviceId hợp lệ."
            );
        }

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_ID,
                returnedDeviceId
            );

            deviceId = returnedDeviceId;
        } catch {
            throw new Error(
                "Không thể lưu deviceId vào trình duyệt."
            );
        }

        // Lưu token nếu /register trả token mới.
        saveReturnedToken(registration.data);

        return {
            deviceId,
            deviceToken
        };
    }

    // Những lỗi khác không được tự động đăng ký lại.
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

/*
 * Không đọc cache.
 * Không lưu danh sách tài liệu.
 * Không hiển thị dữ liệu cũ khi API gặp lỗi.
 */

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

        await ensureDeviceRegistered(controller.signal);

        // /list vẫn gửi deviceId và deviceToken như trước.
        const credentials = getDeviceCredentials();
        const deviceId = String(credentials.deviceId || "").trim();
        const deviceToken = String(credentials.deviceToken || "").trim();

        if (!deviceId) {
            throw new Error(
                "Thiếu deviceId sau khi xác thực thiết bị. Vui lòng tải lại trang."
            );
        }

        const url = new URL(CONFIG.API_URL);
        url.searchParams.set("deviceId", deviceId);

        if (deviceToken) {
            url.searchParams.set("deviceToken", deviceToken);
        }

        url.searchParams.set("_refresh", Date.now().toString());

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept": "application/json",
                "X-Device-Id": deviceId,
                ...(deviceToken ? { "X-Device-Token": deviceToken } : {})
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
        .filter(function(item) {
            return item.id !== "";
        });
}


/* ======================== NORMALIZE ITEM ================= */

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


/* ====================== REMOVE DUPLICATES ================ */

function removeDuplicateIds(items) {
    const map = new Map();

    items.forEach(function(item) {
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

    return state.allItems.filter(function(item) {
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

    filtered.forEach(function(item) {
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

    results.forEach(function(item) {
        DOM.itemsContainer.appendChild(createItemCard(item, true));
    });
}

function searchAllItems(keyword) {
    const normalized = String(keyword).trim().toLowerCase();

    if (!normalized) return [];

    return sortItems(
        state.allItems.filter(function(item) {
            return (
                item.name.toLowerCase().includes(normalized) ||
                item.description.toLowerCase().includes(normalized) ||
                item.type.toLowerCase().includes(normalized) ||
                getExtension(item).includes(normalized)
            );
        })
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


/* ============================ SORT ====================== */

function sortItems(items) {
    return [...items].sort(function(a, b) {
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

        current = state.allItems.find(function(parent) {
            return String(parent.id) === String(parentId);
        });

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

    chain.forEach(function(currentFolder, index) {
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

        current = state.allItems.find(function(parent) {
            return (
                parent.type === "folder" &&
                String(parent.id) === String(parentId)
            );
        });

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
        const count = state.allItems.filter(function(child) {
            return String(child.parentId) === String(item.id);
        }).length;

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
        .map(function(item) {
            return item.folder;
        })
        .filter(Boolean);

    if (state.currentFolder) {
        folders.push(state.currentFolder);
    }

    folders.forEach(function(folder, index) {
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
        .map(function(item) {
            return item.folder;
        })
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
        return (
            "API phản hồi quá lâu sau 20 giây. " +
            "Vui lòng kiểm tra kết nối và thử lại."
        );
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

/*
 * Không lưu hoặc đọc danh sách tài liệu.
 * Chỉ lưu chế độ xem lưới/danh sách.
 * deviceId và deviceToken được quản lý riêng.
 */

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