import bcrypt
from fastapi import Depends, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from lib.prisma_client import db
from middlewares.auth_middleware import require_admin, require_auth
from prisma.enums import Role
from prisma.types import UserUpdateInput
from schemas.user_schemas import DeleteAccountSchema, UpdateProfileSchema, UpdateRoleSchema
from utils.jwt_utils import get_access_cookie_options, get_refresh_cookie_options


def _serialize(user) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "createdAt": user.createdAt.isoformat(),
    }


# ── Self-service profile ─────────────────────────────────────────────────────
async def get_profile(user_id: str = Depends(require_auth)):
    user = await db.user.find_unique(where={"id": user_id})
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    return {
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role,
            "createdAt": user.createdAt.isoformat(),
        }
    }

async def update_profile(payload: UpdateProfileSchema, user_id: str = Depends(require_auth)):
    data: UserUpdateInput = {}
    if payload.name is not None:
        data["name"] = payload.name
    if payload.email is not None:
        existing = await db.user.find_unique(where={"email": payload.email})
        if existing and existing.id != user_id:
            return JSONResponse(status_code=409, content={"error": "Email already registered"})
        data["email"] = payload.email

    user = await db.user.update(where={"id": user_id}, data=data)
    return {"user": _serialize(user)}


async def delete_account(
    payload: DeleteAccountSchema, response: Response, user_id: str = Depends(require_auth)
):
    user = await db.user.find_unique(where={"id": user_id})
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    elif user.role == Role.ADMIN:
        return JSONResponse(status_code=403, content={"error": "Cannot delete admin account"})
    
    valid = await run_in_threadpool(
        bcrypt.checkpw, payload.password.encode(), user.password.encode()
    )
    if not valid:
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})

    # RefreshToken/PasswordResetToken rows cascade-delete via the FK in schema.prisma
    await db.user.delete(where={"id": user_id})

    access_opts = get_access_cookie_options()
    refresh_opts = get_refresh_cookie_options()
    response.delete_cookie("access_token", path=access_opts["path"], samesite=access_opts["samesite"])
    response.delete_cookie("refresh_token", path=refresh_opts["path"], samesite=refresh_opts["samesite"])
    response.status_code = 204
    return response


# ── Admin ─────────────────────────────────────────────────────────────────────
async def list_users(_admin_id: str = Depends(require_admin)):
    users = await db.user.find_many(order={"createdAt": "desc"})
    return {"users": [_serialize(u) for u in users]}


async def update_user_role(
    target_user_id: str, payload: UpdateRoleSchema, _admin_id: str = Depends(require_admin)
):
    user = await db.user.find_unique(where={"id": target_user_id})
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})

    updated = await db.user.update(
        where={"id": target_user_id}, data={"role": Role(payload.role)}
    )
    return {"user": _serialize(updated)}
