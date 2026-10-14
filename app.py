# -*- coding: utf-8 -*-
"""
E1栋电梯公共资金收支管理系统
技术栈: Python Flask + SQLite
- 管理员: 账号密码登录(session/cookie)，支持多管理员；录入/查看/修改/删除收支记录，附件必填(<=5MB)
- 游客(guest): 免登录，可按时间段浏览收入支出明细、查看佐证附件、导出电子表格
- 操作日志: 所有管理员关键操作(登录/增删改/改密/账号管理/导出)均留痕审计
- 密码: werkzeug 哈希存储，绝不明文
- 附件: 存 uploads 目录，数据库仅存路径
"""
import os
import io
import re
import sqlite3
import datetime
from functools import wraps

from flask import (Flask, render_template, request, redirect, url_for,
                   session, flash, send_from_directory, send_file, abort)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "fund.db")
ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "heic", "heif"}
MAX_FILE_BYTES = 5 * 1024 * 1024  # 附件上限 5MB

# 项目公开信息（来自材料）
PROJECT_NAME = "金牛生态小区E1栋一单元电梯公共资金收支管理系统"
FUND_CUSTODIAN = "潘在文"
FUND_ACCOUNT = "6212252201002808180"

app = Flask(__name__)
app.secret_key = os.environ.get("E1FUND_SECRET", "e1fund-2026-secret-key-change-me-please-8f3a2c")
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_BYTES


# ---------------- 数据库 ----------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    conn = get_db()
    # users: 多管理员；扩展字段向后兼容旧库(仅 id,username,password_hash)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            created_by TEXT,
            created_at TEXT,
            disabled INTEGER DEFAULT 0
        )
    """)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    for col, sql in [
        ("display_name", "ALTER TABLE users ADD COLUMN display_name TEXT"),
        ("created_by", "ALTER TABLE users ADD COLUMN created_by TEXT"),
        ("created_at", "ALTER TABLE users ADD COLUMN created_at TEXT"),
        ("disabled", "ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0"),
    ]:
        if col not in cols:
            conn.execute(sql)

    # records 表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            type TEXT NOT NULL,            -- income / expense
            amount REAL NOT NULL,
            description TEXT NOT NULL,
            handler TEXT NOT NULL,
            attachment TEXT,              -- 仅存文件路径(相对 uploads)
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    # logs 表(操作日志/审计)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT,
            action TEXT,
            target_type TEXT,
            target_id TEXT,
            detail TEXT,
            ip TEXT,
            created_at TEXT
        )
    """)

    # 默认管理员(密码哈希存储)；部署后请尽快修改密码
    cur = conn.execute("SELECT COUNT(*) AS c FROM users")
    if cur.fetchone()["c"] == 0:
        conn.execute(
            "INSERT INTO users(username, password_hash, display_name, created_by, created_at, disabled) "
            "VALUES(?,?,?,?,?,0)",
            ("admin", generate_password_hash("admin123"), "系统管理员", "init", _now()))
    # 初始收入数据: 材料中8户集资款，合计 273220 元
    cur = conn.execute("SELECT COUNT(*) AS c FROM records")
    if cur.fetchone()["c"] == 0:
        seed = [
            ("E1-402", "吴志铎（邓梅香缴款）", 30780, "电梯安装集资款（33725? 实缴30780）"),
            ("E1-501", "赵廷花", 37525, "电梯安装集资款（33725+3800）"),
            ("E1-602", "潘在文", 44270, "电梯安装集资款（40470+3800）"),
            ("E1-502", "颜约胜", 37525, "电梯安装集资款（33725+3800）"),
            ("E1-401", "易家凡", 30780, "电梯安装集资款"),
            ("E1-601", "付海燕", 44270, "电梯安装集资款（40470+3800）"),
            ("E1-301", "罗玲茹", 24035, "电梯安装集资款"),
            ("E1-302", "陈健尔", 24035, "电梯安装集资款"),
        ]
        now = _now()
        for room, owner, amount, desc in seed:
            conn.execute(
                "INSERT INTO records(date,type,amount,description,handler,attachment,created_by,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                ("2026-10-07", "income", amount,
                 "电梯安装集资款（户号 %s，户主 %s）：%s" % (room, owner, desc),
                 "潘在文（收款人）", None, "admin", now),
            )
    conn.commit()
    conn.close()


# ---------------- 工具 ----------------
def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def _client_ip():
    try:
        return request.remote_addr or ""
    except Exception:
        return ""


def log_action(actor, action, target_type="", target_id="", detail=""):
    """记录操作日志(审计留痕)"""
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO logs(actor,action,target_type,target_id,detail,ip,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (actor, action, target_type, str(target_id) if target_id != "" else "",
             detail, _client_ip(), _now()))
        conn.commit()
        conn.close()
    except Exception:
        pass


def _valid_date(s):
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", s or ""))


def parse_dates():
    """从请求参数解析并校验 起始/截止 日期"""
    start = request.args.get("start", "").strip()
    end = request.args.get("end", "").strip()
    if not _valid_date(start):
        start = ""
    if not _valid_date(end):
        end = ""
    # 防止起止颠倒
    if start and end and start > end:
        start, end = end, start
    return start, end


def build_where(start, end):
    clauses, params = [], []
    if start:
        clauses.append("date >= ?"); params.append(start)
    if end:
        clauses.append("date <= ?"); params.append(end)
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


def query_records(start, end):
    where, params = build_where(start, end)
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM records" + where + " ORDER BY date DESC, id DESC", params).fetchall()
    conn.close()
    return rows


def summary_filtered(start, end):
    where, params = build_where(start, end)
    conn = get_db()
    row = conn.execute(
        "SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0), "
        "COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) "
        "FROM records" + where, params).fetchone()
    conn.close()
    inc = float(row[0]); exp = float(row[1])
    return inc, exp, inc - exp


def get_summary_global():
    """全局汇总(不受时间段筛选影响)"""
    conn = get_db()
    row = conn.execute(
        "SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS inc, "
        "COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS exp "
        "FROM records").fetchone()
    conn.close()
    inc = float(row["inc"]); exp = float(row["exp"])
    return inc, exp, inc - exp


def build_xlsx(rows, inc, exp, bal, start, end):
    """生成 xlsx 电子表格(内存)"""
    wb = Workbook()
    ws = wb.active
    ws.title = "收支明细"
    title_font = Font(bold=True, size=14, color="1F6FEB")
    head_fill = PatternFill("solid", fgColor="EAF1FB")
    head_font = Font(bold=True, color="1F2933")
    thin = Side(style="thin", color="D0D7DE")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    interval = (start or "最早") + " 至 " + (end or "最新")
    ws.append([PROJECT_NAME])
    ws["A1"].font = title_font
    ws.append(["统计区间", interval])
    ws.append(["总收入(元)", round(inc, 2)])
    ws.append(["总支出(元)", round(exp, 2)])
    ws.append(["账户余额(元)", round(bal, 2)])
    ws.append([])
    headers = ["日期", "类型", "金额(元)", "事项说明", "经办人", "录入人", "录入时间", "佐证附件"]
    ws.append(headers)
    head_row = ws.max_row
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=head_row, column=c)
        cell.fill = head_fill
        cell.font = head_font
        cell.border = border
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for r in rows:
        ws.append([
            r["date"],
            "收入" if r["type"] == "income" else "支出",
            round(float(r["amount"]), 2),
            r["description"],
            r["handler"],
            r["created_by"],
            r["created_at"],
            ("uploads/" + r["attachment"]) if r["attachment"] else "无（初始导入）",
        ])
        rr = ws.max_row
        ws.cell(row=rr, column=3).number_format = "0.00"
        for c in range(1, len(headers) + 1):
            ws.cell(row=rr, column=c).border = border
    widths = [12, 8, 14, 42, 16, 12, 18, 30]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[chr(64 + i) if i <= 26 else "A"].width = w
    ws.freeze_panes = "A%d" % (head_row + 1)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            flash("请先登录管理员账号", "warn")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


# 超级管理员(固定为 admin)：拥有账号管理(新增/删除/重置密码)等最高权限；
# 由主管理员创建的其他管理员不具此权限，但仍可录入/查看/修改/删除自己的记录、查看日志、导出。
SUPER_ADMIN = "admin"


def superadmin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            flash("请先登录管理员账号", "warn")
            return redirect(url_for("login"))
        if session["user"] != SUPER_ADMIN:
            flash("仅超级管理员(admin)可进行账号管理操作", "warn")
            return redirect(url_for("admin_dashboard"))
        return f(*args, **kwargs)
    return decorated


# ---------------- 路由 ----------------
@app.route("/")
def index():
    """公开浏览页(游客免登录)，支持时间段筛选"""
    start, end = parse_dates()
    rows = query_records(start, end)
    inc, exp, net = summary_filtered(start, end)
    _, _, bal = get_summary_global()
    filtered = bool(start or end)
    return render_template("public.html", records=rows, inc=inc, exp=exp, bal=bal,
                           net=net, filtered=filtered, start=start, end=end,
                           project=PROJECT_NAME, custodian=FUND_CUSTODIAN,
                           account=FUND_ACCOUNT, user=session.get("user"))


@app.route("/export")
def export_records():
    """游客导出电子表格(免登录)；尊重当前时间段筛选"""
    start, end = parse_dates()
    rows = query_records(start, end)
    inc, exp, net = summary_filtered(start, end)
    _, _, bal = get_summary_global()
    buf = build_xlsx(rows, inc, exp, bal, start, end)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    actor = session.get("user") or "游客(匿名)"
    log_action(actor, "导出明细", target_type="export",
               detail="区间=%s~%s 记录数=%d" % (start or "最早", end or "最新", len(rows)))
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="E1电梯资金收支明细_%s.xlsx" % ts)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        conn = get_db()
        u = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        if u and not u["disabled"] and check_password_hash(u["password_hash"], password):
            session["user"] = u["username"]
            log_action(u["username"], "登录成功")
            flash("登录成功", "ok")
            return redirect(url_for("admin_dashboard"))
        log_action(username or "(空)", "登录失败", detail="账号或密码错误/已停用")
        flash("账号或密码错误", "warn")
    return render_template("login.html", project=PROJECT_NAME)


@app.route("/logout")
def logout():
    user = session.get("user")
    session.pop("user", None)
    if user:
        log_action(user, "退出登录")
    flash("已退出登录", "ok")
    return redirect(url_for("index"))


@app.route("/admin")
@login_required
def admin_dashboard():
    conn = get_db()
    own = conn.execute(
        "SELECT * FROM records WHERE created_by=? ORDER BY date DESC, id DESC",
        (session["user"],)).fetchall()
    conn.close()
    inc, exp, bal = get_summary_global()
    today = datetime.date.today().isoformat()
    return render_template("admin.html", records=own, inc=inc, exp=exp, bal=bal,
                           project=PROJECT_NAME, today=today, user=session.get("user"))


@app.route("/admin/add", methods=["POST"])
@login_required
def add_record():
    user = session["user"]
    date = request.form.get("date", "").strip()
    rtype = request.form.get("type", "").strip()
    amount_s = request.form.get("amount", "").strip()
    description = request.form.get("description", "").strip()
    handler = request.form.get("handler", "").strip()

    if not date or not _valid_date(date) or rtype not in ("income", "expense") or not description or not handler:
        flash("请完整填写日期、类型、事项说明、经办人", "warn")
        return redirect(url_for("admin_dashboard"))
    try:
        amount = float(amount_s)
        if amount <= 0:
            raise ValueError()
    except ValueError:
        flash("金额必须为大于0的数字", "warn")
        return redirect(url_for("admin_dashboard"))

    f = request.files.get("attachment")
    if not f or f.filename == "":
        flash("佐证附件为必填项，请上传转账截图或票据照片", "warn")
        return redirect(url_for("admin_dashboard"))
    if not allowed_file(f.filename):
        flash("附件格式不支持（限 png/jpg/jpeg/gif/webp/bmp/pdf/heic）", "warn")
        return redirect(url_for("admin_dashboard"))
    f.seek(0, os.SEEK_END); size = f.tell(); f.seek(0)
    if size == 0:
        flash("附件为空，无法提交", "warn")
        return redirect(url_for("admin_dashboard"))
    if size > MAX_FILE_BYTES:
        flash("附件超过 5MB 上限，无法提交", "warn")
        return redirect(url_for("admin_dashboard"))

    ext = f.filename.rsplit(".", 1)[1].lower()
    stored = datetime.datetime.now().strftime("%Y%m%d%H%M%S") + "_" + secure_filename(f.filename)
    if not stored or len(stored) > 120:
        stored = "att_" + datetime.datetime.now().strftime("%Y%m%d%H%M%S%f") + "." + ext
    f.save(os.path.join(UPLOAD_FOLDER, stored))

    now = _now()
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO records(date,type,amount,description,handler,attachment,created_by,created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (date, rtype, amount, description, handler, stored, user, now))
    rid = cur.lastrowid
    conn.commit()
    conn.close()
    log_action(user, "新增记录", target_type="record", target_id=rid,
               detail="%s %s %.2f %s" % (date, "收入" if rtype == "income" else "支出", amount, description[:40]))
    flash("记录已保存（含佐证附件）", "ok")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/edit/<int:rid>", methods=["GET", "POST"])
@login_required
def edit_record(rid):
    user = session["user"]
    conn = get_db()
    rec = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
    if not rec:
        conn.close()
        abort(404)
    if rec["created_by"] != user:
        conn.close()
        flash("只能修改自己录入的记录", "warn")
        return redirect(url_for("admin_dashboard"))

    if request.method == "POST":
        date = request.form.get("date", "").strip()
        rtype = request.form.get("type", "").strip()
        amount_s = request.form.get("amount", "").strip()
        description = request.form.get("description", "").strip()
        handler = request.form.get("handler", "").strip()
        keep = request.form.get("keep_attachment", "1")
        if not date or not _valid_date(date) or rtype not in ("income", "expense") or not description or not handler:
            flash("请完整填写各项", "warn")
            return redirect(url_for("edit_record", rid=rid))
        try:
            amount = float(amount_s)
            if amount <= 0:
                raise ValueError()
        except ValueError:
            flash("金额必须为大于0的数字", "warn")
            return redirect(url_for("edit_record", rid=rid))

        attachment = rec["attachment"]
        f = request.files.get("attachment")
        if f and f.filename != "":
            if not allowed_file(f.filename):
                flash("附件格式不支持", "warn")
                return redirect(url_for("edit_record", rid=rid))
            f.seek(0, os.SEEK_END); size = f.tell(); f.seek(0)
            if size > MAX_FILE_BYTES:
                flash("附件超过 5MB 上限", "warn")
                return redirect(url_for("edit_record", rid=rid))
            ext = f.filename.rsplit(".", 1)[1].lower()
            stored = datetime.datetime.now().strftime("%Y%m%d%H%M%S") + "_" + secure_filename(f.filename)
            f.save(os.path.join(UPLOAD_FOLDER, stored))
            if rec["attachment"]:
                old = os.path.join(UPLOAD_FOLDER, rec["attachment"])
                if os.path.exists(old):
                    try: os.remove(old)
                    except OSError: pass
            attachment = stored
        elif keep != "1" and rec["attachment"]:
            old = os.path.join(UPLOAD_FOLDER, rec["attachment"])
            if os.path.exists(old):
                try: os.remove(old)
                except OSError: pass
            attachment = None

        conn.execute(
            "UPDATE records SET date=?,type=?,amount=?,description=?,handler=?,attachment=? WHERE id=?",
            (date, rtype, amount, description, handler, attachment, rid))
        conn.commit()
        conn.close()
        log_action(user, "修改记录", target_type="record", target_id=rid,
                   detail="%s %s %.2f %s" % (date, "收入" if rtype == "income" else "支出", amount, description[:40]))
        flash("记录已更新", "ok")
        return redirect(url_for("admin_dashboard"))

    conn.close()
    return render_template("edit.html", rec=rec, project=PROJECT_NAME, user=session.get("user"))


@app.route("/admin/delete/<int:rid>", methods=["POST"])
@login_required
def delete_record(rid):
    user = session["user"]
    conn = get_db()
    rec = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
    if not rec:
        conn.close()
        abort(404)
    if rec["created_by"] != user:
        conn.close()
        flash("只能删除自己录入的记录", "warn")
        return redirect(url_for("admin_dashboard"))
    if rec["attachment"]:
        old = os.path.join(UPLOAD_FOLDER, rec["attachment"])
        if os.path.exists(old):
            try: os.remove(old)
            except OSError: pass
    conn.execute("DELETE FROM records WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    log_action(user, "删除记录", target_type="record", target_id=rid,
               detail=rec["description"][:40])
    flash("记录已删除", "ok")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/change_password", methods=["GET", "POST"])
@login_required
def change_password():
    user = session["user"]
    if request.method == "POST":
        old = request.form.get("old", "")
        new1 = request.form.get("new1", "")
        new2 = request.form.get("new2", "")
        conn = get_db()
        u = conn.execute("SELECT * FROM users WHERE username=?", (user,)).fetchone()
        if not u or not check_password_hash(u["password_hash"], old):
            flash("原密码错误", "warn")
            conn.close()
            return redirect(url_for("change_password"))
        if new1 != new2 or len(new1) < 6:
            flash("两次新密码不一致或长度不足6位", "warn")
            conn.close()
            return redirect(url_for("change_password"))
        conn.execute("UPDATE users SET password_hash=? WHERE username=?",
                     (generate_password_hash(new1), user))
        conn.commit()
        conn.close()
        log_action(user, "修改密码")
        flash("密码已修改", "ok")
        return redirect(url_for("admin_dashboard"))
    return render_template("change_password.html", project=PROJECT_NAME, user=session.get("user"))


# ---------------- 多管理员管理（仅超级管理员 admin 可操作） ----------------
@app.route("/admin/users")
@superadmin_required
def list_users():
    user = session["user"]
    conn = get_db()
    users = conn.execute(
        "SELECT id,username,display_name,created_by,created_at,disabled FROM users ORDER BY id").fetchall()
    conn.close()
    return render_template("users.html", users=users, user=user, project=PROJECT_NAME)


@app.route("/admin/users/add", methods=["POST"])
@superadmin_required
def add_user():
    user = session["user"]
    un = request.form.get("username", "").strip()
    pw = request.form.get("password", "")
    dn = request.form.get("display_name", "").strip()
    if len(un) < 3:
        flash("账号至少3位", "warn")
        return redirect(url_for("list_users"))
    if len(pw) < 6:
        flash("密码至少6位", "warn")
        return redirect(url_for("list_users"))
    conn = get_db()
    if conn.execute("SELECT id FROM users WHERE username=?", (un,)).fetchone():
        conn.close()
        flash("该账号已存在", "warn")
        return redirect(url_for("list_users"))
    conn.execute(
        "INSERT INTO users(username,password_hash,display_name,created_by,created_at,disabled) "
        "VALUES(?,?,?,?,?,0)",
        (un, generate_password_hash(pw), dn or un, user, _now()))
    conn.commit()
    conn.close()
    log_action(user, "新增管理员", target_type="user", detail="账号 " + un)
    flash("管理员账号已创建", "ok")
    return redirect(url_for("list_users"))


@app.route("/admin/users/delete/<int:uid>", methods=["POST"])
@superadmin_required
def delete_user(uid):
    user = session["user"]
    conn = get_db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        conn.close()
        abort(404)
    if u["username"] == user:
        conn.close()
        flash("不能删除当前登录账号", "warn")
        return redirect(url_for("list_users"))
    if conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] <= 1:
        conn.close()
        flash("至少保留一个管理员账号", "warn")
        return redirect(url_for("list_users"))
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.commit()
    conn.close()
    log_action(user, "删除管理员", target_type="user", detail="账号 " + u["username"])
    flash("已删除管理员账号", "ok")
    return redirect(url_for("list_users"))


@app.route("/admin/users/resetpw/<int:uid>", methods=["POST"])
@superadmin_required
def reset_user_pw(uid):
    user = session["user"]
    pw = request.form.get("password", "")
    if len(pw) < 6:
        flash("新密码至少6位", "warn")
        return redirect(url_for("list_users"))
    conn = get_db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        conn.close()
        abort(404)
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(pw), uid))
    conn.commit()
    conn.close()
    log_action(user, "重置密码", target_type="user", detail="账号 " + u["username"])
    flash("已重置该管理员密码", "ok")
    return redirect(url_for("list_users"))


# ---------------- 操作日志 ----------------
@app.route("/admin/logs")
@login_required
def view_logs():
    conn = get_db()
    logs = conn.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 500").fetchall()
    conn.close()
    return render_template("logs.html", logs=logs, user=session.get("user"), project=PROJECT_NAME)


@app.route("/uploads/<path:filename>")
def uploads(filename):
    """佐证附件公开可查(供业主监督)；做基础防目录穿越"""
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        abort(404)
    return send_from_directory(UPLOAD_FOLDER, filename)


@app.errorhandler(413)
@app.errorhandler(404)
def err(e):
    if e.code == 413:
        flash("上传文件超过 5MB 上限", "warn")
        return redirect(url_for("admin_dashboard"))
    return render_template("public.html", records=[], inc=0, exp=0, bal=0, net=0,
                           filtered=False, start="", end="",
                           project=PROJECT_NAME, custodian=FUND_CUSTODIAN,
                           account=FUND_ACCOUNT, user=session.get("user")), 404


if __name__ == "__main__":
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    init_db()
    # 0.0.0.0 便于同局域网/云端访问；端口优先取环境变量 PORT（发布到云端时由平台注入），默认 5000
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
