"use strict";

/* =====================================================
   CẤU HÌNH ADMIN
===================================================== */

const DEFAULT_WORKER =
    "https://api-admin.abcd1601ab.workers.dev";

const DEFAULT_GAS =
    "https://api-admin.abcd1601ab.workers.dev";

let config = {
    worker: localStorage.getItem("admin_worker_url") || DEFAULT_WORKER,
    gas: localStorage.getItem("admin_gas_url") || DEFAULT_GAS,
    key: localStorage.getItem("admin_key") || ""
};

let files = [];
let quizzes = [];
let devices = [];
let modalState = null;

const $ = id => document.getElementById(id);

const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[char]));

/* =====================================================
   THÔNG BÁO
===================================================== */

function showNotice(message, type = "info") {
    const notice = $("notice");
    if (!notice) return;

    notice.textContent = message;
    notice.className = "notice show " + type;

    window.clearTimeout(showNotice.timer);

    showNotice.timer = setTimeout(() => {
        notice.className = "notice";
    }, 6500);
}

/* =====================================================
   ĐIỀU HƯỚNG
===================================================== */

function toggleSidebar(open) {
    $("sidebar")?.classList.toggle("open", open);
    $("shade")?.classList.toggle("show", open);
}

function navigate(page) {
    document.querySelectorAll(".section").forEach(section => {
        section.classList.remove("active");
    });

    $("page-" + page)?.classList.add("active");

    document.querySelectorAll(".nav button").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.page === page
        );
    });

    const titles = {
        dashboard: "Tổng quan hệ thống",
        files: "Quản lý kho tài liệu",
        quizzes: "Quản lý kho Quiz",
        devices: "Quản lý thiết bị",
        settings: "Cấu hình kết nối API"
    };

    if ($("pageTitle")) {
        $("pageTitle").textContent = titles[page] || "Quản trị";
    }

    toggleSidebar(false);

    if (page === "files") renderFiles();
    if (page === "quizzes") renderQuizzes();
    if (page === "devices") loadDevices();
}

document.querySelectorAll(".nav button").forEach(button => {
    button.addEventListener("click", () => {
        navigate(button.dataset.page);
    });
});

/* =====================================================
   CẤU HÌNH API
===================================================== */

function saveSettings() {
    config.worker =
        ($("workerUrl")?.value || DEFAULT_WORKER)
            .trim()
            .replace(/\/+$/, "");

    config.gas =
        ($("gasUrl")?.value || DEFAULT_GAS).trim();

    config.key =
        ($("adminKey")?.value || "").trim();

    localStorage.setItem("admin_worker_url", config.worker);
    localStorage.setItem("admin_gas_url", config.gas);
    localStorage.setItem("admin_key", config.key);

    showNotice(
        "Đã lưu cấu hình trên trình duyệt này.",
        "success"
    );

    loadAll();
}

function initSettings() {
    if ($("workerUrl")) {
        $("workerUrl").value = config.worker;
    }

    if ($("gasUrl")) {
        $("gasUrl").value = config.gas;
    }

    if ($("adminKey")) {
        $("adminKey").value = config.key;
    }
}

/* =====================================================
   GỌI API
===================================================== */

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
                "Accept": "application/json"
            }
        });

        const text = await response.text();
        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(
                "API không trả JSON hợp lệ. " +
                "Kiểm tra URL Apps Script, quyền triển khai và phản hồi API."
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

        if (
            error instanceof TypeError &&
            /fetch/i.test(error.message)
        ) {
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
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.files)) return data.files;
    if (Array.isArray(data?.quizzes)) return data.quizzes;
    if (Array.isArray(data?.devices)) return data.devices;

    return [];
}

async function fetchEndpoint(action) {
    if (!config.gas) {
        throw new Error("Chưa cấu hình Apps Script URL.");
    }

    const url = new URL(config.gas);

    url.searchParams.set("action", action);
    url.searchParams.set("_", String(Date.now()));

    /*
       Apps Script doGet đọc e.parameter.adminKey.
       Vì vậy phải truyền adminKey qua URL,
       không chỉ gửi X-Admin-Key trong header.
    */

    if (config.key) {
        url.searchParams.set("adminKey", config.key);
    } else {
        url.searchParams.delete("adminKey");
    }

    const result = await request(url.toString());

    if (result && result.success === false) {
        throw new Error(
            result.message ||
            result.error ||
            "Apps Script từ chối yêu cầu quản trị."
        );
    }

    if (result && result.ok === false) {
        throw new Error(
            result.message ||
            result.error ||
            "API trả về trạng thái thất bại."
        );
    }

    return result;
}

/* =====================================================
   TẢI DỮ LIỆU QUẢN TRỊ
===================================================== */

async function loadAll() {
    showNotice("Đang tải dữ liệu…", "info");

    if ($("connectionText")) {
        $("connectionText").textContent = "Đang kết nối API…";
    }

    const results = await Promise.allSettled([
        fetchEndpoint("admin_files"),
        fetchEndpoint("admin_quizzes"),
        fetchEndpoint("admin_devices")
    ]);

    let successful = 0;
    const errors = [];

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            successful++;

            const data = dataArray(result.value);

            if (index === 0) files = data;
            if (index === 1) quizzes = data;
            if (index === 2) devices = data;
        } else {
            errors.push(
                result.reason?.message || "Lỗi không xác định"
            );

            console.warn(
                "Admin API thất bại:",
                index,
                result.reason
            );
        }
    });

    if ($("connectionText")) {
        $("connectionText").textContent =
            successful > 0
                ? "Đã nhận dữ liệu từ " + successful + "/3 API"
                : "Chưa kết nối được Admin API";
    }

    renderAll();

    if (successful === 3) {
        showNotice(
            "Đã tải dữ liệu từ cả 3 API quản trị.",
            "success"
        );
    } else if (successful > 0) {
        showNotice(
            "Đã tải một phần dữ liệu (" +
            successful +
            "/3). " +
            (errors[0] || "Một số API chưa phản hồi."),
            "info"
        );
    } else {
        showNotice(
            "Không tải được dữ liệu quản trị. " +
            (errors[0] || "Kiểm tra cấu hình API và ADMIN_KEY."),
            "error"
        );
    }
}

function loadDevices() {
    if (!config.gas) {
        renderDevices();
        return;
    }

    fetchEndpoint("admin_devices")
        .then(data => {
            devices = dataArray(data);

            renderDevices();
            renderStats();
            renderRecent();
        })
        .catch(error => {
            renderDevices();

            showNotice(
                "Không tải được thiết bị: " + error.message,
                "error"
            );
        });
}

function refreshCurrent() {
    const active = document.querySelector(".section.active")?.id;

    if (active === "page-devices") {
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

/* =====================================================
   THỐNG KÊ
===================================================== */

function renderStats() {
    if ($("statFiles")) {
        $("statFiles").textContent = files.length;
    }

    if ($("statQuizzes")) {
        $("statQuizzes").textContent = quizzes.length;
    }

    if ($("statActive")) {
        $("statActive").textContent = devices.filter(device =>
            String(device.status || "").toLowerCase() === "active"
        ).length;
    }

    if ($("statLocked")) {
        $("statLocked").textContent = devices.filter(device =>
            String(device.status || "").toLowerCase() === "locked"
        ).length;
    }

    if ($("fileNavCount")) {
        $("fileNavCount").textContent = files.length || "";
    }
}

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

function statusBadge(status) {
    status = String(status || "").toLowerCase();

    const className = ["active", "open"].includes(status)
        ? "active"
        : ["locked", "closed", "inactive"].includes(status)
            ? "locked"
            : ["expired", "upcoming", "pending"].includes(status)
                ? "pending"
                : "neutral";

    const labels = {
        active: "Đang hoạt động",
        locked: "Đã khóa",
        expired: "Hết hạn",
        open: "Đang mở",
        upcoming: "Chưa mở",
        closed: "Đã đóng",
        inactive: "Đang tắt",
        pending: "Chờ xử lý"
    };

    return `
        <span class="badge ${className}">
            ${esc(labels[status] || status || "Không rõ")}
        </span>
    `;
}

/* =====================================================
   KHO TÀI LIỆU
===================================================== */

function renderFiles() {
    if (!$("filesBody")) return;

    const query =
        ($("fileSearch")?.value || "").toLowerCase();

    const status =
        $("fileStatus")?.value || "";

    const rows = files
        .filter(file =>
            JSON.stringify(file).toLowerCase().includes(query)
        )
        .filter(file => {
            if (!status) return true;

            const activeValue = String(
                val(file, "isActive", "active")
            ).toLowerCase();

            const isInactive = [
                "false",
                "0",
                "no",
                "inactive"
            ].includes(activeValue);

            return status === "active"
                ? !isInactive
                : isInactive;
        });

    $("filesBody").innerHTML = rows.length
        ? rows.map(file => {
            const id = val(file, "id");

            const activeValue = String(
                val(file, "isActive", "active")
            ).toLowerCase();

            const inactive = [
                "false",
                "0",
                "no",
                "inactive"
            ].includes(activeValue);

            return `
                <tr>
                    <td>${esc(id)}</td>

                    <td>
                        <div class="item-title">
                            ${esc(
                                val(file, "name", "title", "fileName") ||
                                "Chưa có tên"
                            )}
                        </div>

                        <div class="sub">
                            ${esc(val(file, "description", "desc"))}
                        </div>
                    </td>

                    <td>
                        ${esc(
                            val(file, "folder", "category", "type") || "—"
                        )}
                    </td>

                    <td>
                        ${statusBadge(inactive ? "inactive" : "active")}
                    </td>

                    <td>
                        <div class="actions">
                            <button class="mini"
                                title="Xem chi tiết"
                                onclick="viewItem('file', '${esc(id)}')">
                                <i class="fa-regular fa-eye"></i>
                            </button>

                            <button class="mini"
                                title="Sao chép ID"
                                onclick="copyText('${esc(id)}')">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("")
        : `
            <tr>
                <td colspan="5">
                    <div class="empty">
                        <i class="fa-regular fa-folder-open"></i>
                        ${
                            files.length
                                ? "Không tìm thấy tài liệu phù hợp."
                                : "Chưa có dữ liệu tài liệu. Hãy kiểm tra API quản trị."
                        }
                    </div>
                </td>
            </tr>
        `;

    if ($("filesCount")) {
        $("filesCount").textContent =
            `${rows.length} / ${files.length} tài liệu`;
    }
}
/* =====================================================
   KHO QUIZ
===================================================== */

function quizState(quiz) {
    const status = String(
        val(quiz, "status")
    ).toLowerCase();

    if (["open", "upcoming", "closed"].includes(status)) {
        return status;
    }

    const now = Date.now();

    const start = Date.parse(
        val(quiz, "startTime", "start", "startDate") || ""
    ) || 0;

    const end = Date.parse(
        val(quiz, "endTime", "end", "endDate") || ""
    ) || 0;

    if (start && now < start) return "upcoming";
    if (end && now > end) return "closed";

    return "open";
}

function renderQuizzes() {
    if (!$("quizzesBody")) return;

    const query =
        ($("quizSearch")?.value || "").toLowerCase();

    const status =
        $("quizStatus")?.value || "";

    const rows = quizzes
        .filter(quiz =>
            JSON.stringify(quiz).toLowerCase().includes(query)
        )
        .filter(quiz =>
            !status || quizState(quiz) === status
        );

    $("quizzesBody").innerHTML = rows.length
        ? rows.map(quiz => {
            const id = val(quiz, "id") || val(quiz, "code");

            return `
                <tr>
                    <td>${esc(val(quiz, "id") || "—")}</td>

                    <td>
                        <div class="item-title">
                            ${esc(val(quiz, "name", "title") || "Chưa có tên")}
                        </div>

                        <div class="sub">
                            ${esc(val(quiz, "desc", "description"))}
                        </div>
                    </td>

                    <td>
                        <b>${esc(val(quiz, "code", "quizCode") || "—")}</b>
                    </td>

                    <td>
                        ${statusBadge(quizState(quiz))}
                    </td>

                    <td>
                        <div>
                            ${esc(
                                val(quiz, "startTime", "start", "startDate") ||
                                "Mặc định"
                            )}
                        </div>

                        <div class="sub">
                            Đến:
                            ${esc(
                                val(quiz, "endTime", "end", "endDate") ||
                                "Không giới hạn"
                            )}
                        </div>
                    </td>

                    <td>
                        <div class="actions">
                            <button class="mini"
                                title="Xem chi tiết"
                                onclick="viewItem('quiz', '${esc(id)}')">
                                <i class="fa-regular fa-eye"></i>
                            </button>

                            <button class="mini"
                                title="Sao chép mã"
                                onclick="copyText('${esc(val(quiz, "code"))}')">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("")
        : `
            <tr>
                <td colspan="6">
                    <div class="empty">
                        <i class="fa-solid fa-graduation-cap"></i>
                        ${
                            quizzes.length
                                ? "Không tìm thấy quiz phù hợp."
                                : "Chưa có dữ liệu quiz. Hãy kiểm tra API quản trị."
                        }
                    </div>
                </td>
            </tr>
        `;

    if ($("quizzesCount")) {
        $("quizzesCount").textContent =
            `${rows.length} / ${quizzes.length} bài quiz`;
    }
}

/* =====================================================
   QUẢN LÝ THIẾT BỊ
===================================================== */

function renderDevices() {
    if (!$("devicesBody")) return;

    const query =
        ($("deviceSearch")?.value || "").toLowerCase();

    const status =
        ($("deviceStatus")?.value || "").toLowerCase();

    const rows = devices
        .filter(device =>
            JSON.stringify(device).toLowerCase().includes(query)
        )
        .filter(device =>
            !status ||
            String(device.status || "").toLowerCase() === status
        );

    $("devicesBody").innerHTML = rows.length
        ? rows.map(device => {
            const id = val(device, "deviceId", "id");

            const locked =
                String(device.status || "").toLowerCase() === "locked";

            return `
                <tr>
                    <td>
                        <div class="item-title">
                            ${esc(id || "—")}
                        </div>

                        <div class="sub">
                            ${esc(val(device, "createdAt") || "")}
                        </div>
                    </td>

                    <td>${esc(val(device, "ip") || "—")}</td>

                    <td>${statusBadge(val(device, "status"))}</td>

                    <td>${esc(val(device, "lastEvent") || "—")}</td>

                    <td>${esc(val(device, "lastSeen") || "—")}</td>

                    <td>
                        <button class="btn"
                            onclick="viewIPs('${esc(id)}')">
                            Xem IP
                        </button>
                    </td>

                    <td>
                        <div class="actions">
                            <button class="mini"
                                title="Xem"
                                onclick="viewItem('device', '${esc(id)}')">
                                <i class="fa-regular fa-eye"></i>
                            </button>

                            ${
                                locked
                                    ? `
                                        <button class="mini"
                                            title="Mở khóa thiết bị"
                                            onclick="confirmUnlock('${esc(id)}')">
                                            <i class="fa-solid fa-lock-open"></i>
                                        </button>
                                    `
                                    : `
                                        <button class="mini"
                                            title="Khóa thiết bị"
                                            onclick="confirmLock('${esc(id)}')">
                                            <i class="fa-solid fa-lock"></i>
                                        </button>
                                    `
                            }

                            <button class="mini"
                                title="Xóa thiết bị"
                                onclick="confirmDeleteDevice('${esc(id)}')">
                                <i class="fa-regular fa-trash-can"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("")
        : `
            <tr>
                <td colspan="7">
                    <div class="empty">
                        <i class="fa-solid fa-laptop"></i>
                        ${
                            devices.length
                                ? "Không tìm thấy thiết bị phù hợp."
                                : "Chưa có dữ liệu thiết bị. Kiểm tra API quản trị."
                        }
                    </div>
                </td>
            </tr>
        `;

    if ($("devicesCount")) {
        $("devicesCount").textContent =
            `${rows.length} / ${devices.length} thiết bị`;
    }
}

function renderRecent() {
    if (!$("recentBody")) return;

    const rows = [...devices]
        .sort((a, b) =>
            (Date.parse(val(b, "lastSeen")) || 0) -
            (Date.parse(val(a, "lastSeen")) || 0)
        )
        .slice(0, 5);

    $("recentBody").innerHTML = rows.length
        ? rows.map(device => `
            <tr>
                <td>
                    <div class="item-title">
                        ${esc(val(device, "deviceId") || "—")}
                    </div>
                </td>

                <td>${esc(val(device, "ip") || "—")}</td>
                <td>${esc(val(device, "lastEvent") || "—")}</td>
                <td>${statusBadge(val(device, "status"))}</td>
                <td>${esc(val(device, "lastSeen") || "—")}</td>
            </tr>
        `).join("")
        : `
            <tr>
                <td colspan="5">
                    <div class="empty">
                        Chưa có hoạt động để hiển thị.
                    </div>
                </td>
            </tr>
        `;
}
/* =====================================================
   HỘP THOẠI
===================================================== */

function openModal(title, body, primary = "Đóng", action = null) {
    modalState = action;

    if ($("modalTitle")) {
        $("modalTitle").textContent = title;
    }

    if ($("modalBody")) {
        $("modalBody").innerHTML = body;
    }

    if ($("modalPrimary")) {
        $("modalPrimary").textContent = primary;
        $("modalPrimary").style.display =
            action ? "inline-block" : "none";
    }

    $("modalBackdrop")?.classList.add("show");
}

function closeModal() {
    $("modalBackdrop")?.classList.remove("show");
    modalState = null;
}

function modalAction() {
    if (typeof modalState === "function") {
        modalState();
    }
}

function viewItem(type, id) {
    const list =
        type === "file"
            ? files
            : type === "quiz"
                ? quizzes
                : devices;

    const item = list.find(value =>
        String(
            val(
                value,
                type === "device" ? "deviceId" : "id",
                type === "quiz" ? "code" : "id"
            )
        ) === String(id)
    );

    if (!item) {
        showNotice("Không tìm thấy dữ liệu cần xem.", "error");
        return;
    }

    const body = Object.entries(item)
        .filter(([key]) =>
            !key.toLowerCase().includes("token")
        )
        .map(([key, value]) => `
            <div style="padding:9px 0;border-bottom:1px solid #edf0f5">
                <div style="font-size:10px;color:#8a94a8;margin-bottom:4px">
                    ${esc(key)}
                </div>

                <div style="font-size:12px;overflow-wrap:anywhere">
                    ${esc(
                        typeof value === "object"
                            ? JSON.stringify(value)
                            : value
                    )}
                </div>
            </div>
        `).join("");

    openModal(
        "Chi tiết " + ({
            file: "tài liệu",
            quiz: "quiz",
            device: "thiết bị"
        }[type]),
        body
    );
}

function viewIPs(id) {
    const device = devices.find(item =>
        String(val(item, "deviceId", "id")) === String(id)
    );

    if (!device) {
        showNotice("Không tìm thấy thiết bị.", "error");
        return;
    }

    const ips = String(
        val(device, "ipHistory", "ip") || ""
    ).split("|").filter(Boolean);

    openModal(
        "Lịch sử IP — " + id,
        ips.length
            ? ips.map(ip => `
                <div style="padding:11px;border-bottom:1px solid var(--line);font-size:12px">
                    <i class="fa-solid fa-network-wired"
                       style="color:var(--primary);margin-right:8px"></i>
                    ${esc(ip)}
                </div>
            `).join("")
            : "<p>Không có lịch sử IP.</p>"
    );
}

/* =====================================================
   THAO TÁC QUẢN TRỊ
===================================================== */

function confirmLock(id) {
    openModal(
        "Khóa thiết bị?",
        `
            <p style="font-size:12px;line-height:1.7;color:#667085">
                Thiết bị <b>${esc(id)}</b> sẽ bị khóa nếu backend
                chấp nhận và cập nhật trạng thái thành công.
            </p>

            <p style="font-size:11px;color:#c24141">
                Hãy xác nhận đúng thiết bị trước khi thực hiện.
            </p>
        `,
        "Khóa thiết bị",
        async () => {
            try {
                await adminAction("lock_device", {
                    deviceId: id
                });

                closeModal();
                await loadDevices();
            } catch (error) {
                showNotice(error.message, "error");
            }
        }
    );
}

function confirmUnlock(id) {
    openModal(
        "Mở khóa thiết bị?",
        `
            <p style="font-size:12px;line-height:1.7;color:#667085">
                Thiết bị <b>${esc(id)}</b> sẽ được mở khóa.
                Nếu token đã hết hạn, thiết bị vẫn cần thực hiện
                quy trình gia hạn theo API.
            </p>
        `,
        "Mở khóa thiết bị",
        async () => {
            try {
                await adminAction("unlock_device", {
                    deviceId: id
                });

                closeModal();
                await loadDevices();
            } catch (error) {
                showNotice(
                    "Không mở khóa được thiết bị: " + error.message,
                    "error"
                );
            }
        }
    );
}

function confirmDeleteDevice(id) {
    openModal(
        "Xóa thiết bị?",
        `
            <p style="font-size:12px;line-height:1.7;color:#667085">
                Em sắp xóa thiết bị <b>${esc(id)}</b> khỏi danh sách
                quản trị. Thao tác này không thể hoàn tác.
            </p>

            <p style="font-size:11px;color:#c24141">
                Chỉ xác nhận nếu em chắc chắn muốn xóa thiết bị này.
            </p>
        `,
        "Xóa thiết bị",
        async () => {
            try {
                await adminAction("delete_device", {
                    deviceId: id
                });

                closeModal();
                await loadDevices();
            } catch (error) {
                showNotice(
                    "Không xóa được thiết bị: " + error.message,
                    "error"
                );
            }
        }
    );
}

async function adminAction(action, data = {}) {
    if (!config.gas) {
        throw new Error("Chưa cấu hình Admin API.");
    }

    const url = new URL(config.gas);

    url.searchParams.set("action", "admin_" + action);
    url.searchParams.set("_", String(Date.now()));

    Object.entries(data).forEach(([key, value]) => {
        url.searchParams.set(key, String(value ?? ""));
    });

    if (config.key) {
        url.searchParams.set("adminKey", config.key);
    } else {
        url.searchParams.delete("adminKey");
    }

    const result = await request(url.toString());

    if (
        result &&
        (result.success === false || result.ok === false)
    ) {
        throw new Error(
            result.message ||
            result.error ||
            "Thao tác thất bại."
        );
    }

    showNotice(
        "API đã phản hồi yêu cầu. Hãy kiểm tra dữ liệu đã cập nhật.",
        "success"
    );

    return result;
}
/* =====================================================
   THÊM TÀI LIỆU / QUIZ
===================================================== */

function openItemModal(type) {
    const isFile = type === "file";

    openModal(
        isFile ? "Thêm tài liệu" : "Thêm Quiz",
        `
            <p style="font-size:12px;line-height:1.7;color:#667085">
                Nhập thông tin bên dưới. Việc lưu dữ liệu thật cần
                endpoint thêm dữ liệu tương ứng trong Apps Script.
            </p>

            <div class="field">
                <label>Tên ${isFile ? "tài liệu" : "quiz"}</label>
                <input id="newName" placeholder="Nhập tên...">
            </div>

            <div class="field">
                <label>${isFile ? "ID tài liệu" : "Mã tham gia quiz"}</label>
                <input id="newCode" placeholder="Nhập ID / mã...">
            </div>
        `,
        "Gửi yêu cầu",
        async () => {
            const name = $("newName")?.value.trim() || "";
            const code = $("newCode")?.value.trim() || "";

            if (!name || !code) {
                showNotice(
                    "Em hãy nhập đủ tên và ID/mã.",
                    "error"
                );
                return;
            }

            const action = isFile
                ? "add_file"
                : "add_quiz";

            try {
                await adminAction(action, {
                    name,
                    id: isFile ? code : "",
                    code: isFile ? "" : code
                });

                closeModal();
                await loadAll();
            } catch (error) {
                showNotice(
                    "Chưa thêm được dữ liệu: " + error.message,
                    "error"
                );
            }
        }
    );
}

/* =====================================================
   SAO CHÉP
===================================================== */

async function copyText(value) {
    if (!value) {
        showNotice("Không có nội dung để sao chép.", "info");
        return;
    }

    try {
        await navigator.clipboard.writeText(String(value));
        showNotice("Đã sao chép.", "success");
    } catch {
        showNotice(
            "Không thể sao chép tự động trên trình duyệt này.",
            "error"
        );
    }
}

/* =====================================================
   KHỞI TẠO
===================================================== */

initSettings();
renderAll();

/*
  Tự tải dữ liệu từ Apps Script khi mở trang.

  Các action cần tồn tại trong backend:
  - admin_files
  - admin_quizzes
  - admin_devices
  - admin_lock_device
  - admin_unlock_device
  - admin_delete_device
  - admin_add_file
  - admin_add_quiz
*/

loadAll();