// Элементы формы логина
const loginPhone = document.getElementById('loginPhone');
const loginPassword = document.getElementById('loginPassword');
const loginButton = document.getElementById('register-btn-login');
const loginMessage = document.getElementById('loginMessage');
const loginRulesCheck = document.getElementById('loginRulesCheck');
const passwordToggle = document.querySelector('.password-toggle-login');
const loginInputs = document.querySelector('.login-inputs');

loginInputs.addEventListener("click", (e) => {
  // Если клик по фото-блоку, ничего не делаем
  if (e.target.closest('.photo-upload-item')) {
      return;
  }

  loginPhone.classList.remove("error");
  loginPassword.classList.remove("error");
  loginRulesCheck.classList.remove("error");

  loginPhone.style.borderColor = "";
  loginPassword.style.borderColor = "";
  loginRulesCheck.style.borderColor = "";
  hideLoginMessage();

});

// Валидные коды номеров Азербайджана
const validAzerbaijanCodes = [
    "77", "70", "50", "51", 
    "55", "40", "60", "12", 
    "20", "88", "99"];

// Обработчик ввода телефона
loginPhone.addEventListener("input", () => {
    let value = loginPhone.value.replace(/\D/g, '').slice(0, 9);
    let formatted = '';

    if (value.length > 0) formatted += value.slice(0, 2);
    if (value.length > 2) formatted += ' ' + value.slice(2, 5);
    if (value.length > 5) formatted += ' ' + value.slice(5, 7);
    if (value.length > 7) formatted += '-' + value.slice(7, 9);

    loginPhone.value = formatted.trim();
});

// Переключение видимости пароля
passwordToggle.addEventListener("click", () => {
    if (loginPassword.type === "password") {
        loginPassword.type = "text";
        passwordToggle.innerHTML = '<i class="fas fa-eye-slash"></i>';
    } else {
        loginPassword.type = "password";
        passwordToggle.innerHTML = '<i class="fas fa-eye"></i>';
    }
});

// Обработчик отправки формы
loginButton.addEventListener("click", async () => {
    // Сброс предыдущих ошибок
    resetLoginErrors();
    hideLoginMessage();

    let valid = true;

    // Валидация данных
    if (!loginPhone.value.match(/^\d{2} \d{3} \d{2}-\d{2}$/)) {
        loginPhone.classList.add("error");
        showLoginError("Неверный формат телефона!");
        valid = false;
    }

    if (loginPassword.value.length < 6) {
        loginPassword.classList.add("error");
        showLoginError("Пароль должен содержать минимум 6 символов!");
        valid = false;
    }

    if (!loginRulesCheck.checked) {
        loginRulesCheck.classList.add("error");
        showLoginError("Необходимо согласие с правилами!");
        valid = false;
    }

    // Проверка кода телефона
    if (!validAzerbaijanCodes.includes(loginPhone.value.replace(/\D/g, "").substring(0, 2))) {
        loginPhone.classList.add("error");
        showLoginError("Недопустимый код телефона!");
        valid = false;
    }

    if (!valid) return;

    // Показываем загрузку
    setLoginLoading(true);

    try {
        // Отправляем данные на сервер
        const response = await fetch('/api/login-client', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                phone: loginPhone.value,
                password: loginPassword.value,
                agree_to_terms: loginRulesCheck.checked
            })
        });

        const result = await response.json();

        if (result.success) {
            // Успешный логин
            showLoginSuccess(result.message);
            window.location.reload();
            // Перенаправляем на главную страницу через 1 секунду
            // setTimeout(() => {
            //     loginPhone.value = '';
            //     loginPassword.value = '';
            //     loginRulesCheck.checked = false;
            //     window.taxiApp.showScreen('profile-screen');
            //     window.profileManager.loadProfileData();
            //     hideLoginMessage();
            //     setLoginLoading(false);
            // }, 1000);
            
        } else {
            // Обработка ошибок сервера
            handleLoginServerError(result);
        }

    } catch (error) {
        console.error('Ошибка при входе:', error);
        showLoginError('Ошибка соединения с сервером. Попробуйте позже.');
    } finally {
        setLoginLoading(false);
    }
});

// Функции для работы с сообщениями и состоянием
function showLoginError(message) {
    if (loginMessage) {
        loginMessage.textContent = message;
        loginMessage.classList.add('error');
        loginMessage.classList.remove('success');
        loginMessage.style.display = 'block';
    }
}

function showLoginSuccess(message) {
    if (loginMessage) {
        loginMessage.textContent = message;
        loginMessage.classList.add('success');
        loginMessage.classList.remove('error');
        loginMessage.style.display = 'block';
    }
}

function hideLoginMessage() {
    if (loginMessage) {
        loginMessage.style.display = 'none';
        loginMessage.textContent = '';
    }
}

function resetLoginErrors() {
    loginPhone.classList.remove("error");
    loginPassword.classList.remove("error");
    loginRulesCheck.classList.remove("error");
}

function setLoginLoading(loading) {
    if (loading) {
        loginButton.disabled = true;
        loginButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Вход...';
    } else {
        loginButton.disabled = false;
        loginButton.innerHTML = '<i class="fas fa-sign-in-alt"></i> Войти';
    }
}

function handleLoginServerError(result) {
    switch (result.error) {
        case 'phone_format':
            loginPhone.classList.add("error");
            showLoginError("Неверный формат телефона");
            break;
        case 'password_incorrect':
        case 'wrong_password':
            loginPassword.classList.add("error");
            showLoginError(result.message || "Неверный пароль");
            break;
        case 'user_not_found':
        case 'client_not_found':
            loginPhone.classList.add("error");
            showLoginError(result.message || "Пользователь с таким телефоном не найден");
            break;
        case 'account_banned':
            loginPhone.classList.add("error");
            showLoginError(result.message || "Аккаунт заблокирован (бан).");
            break;
        case 'account_disabled':
            loginPhone.classList.add("error");
            showLoginError(result.message || "Аккаунт отключён администратором.");
            break;
        case 'account_blocked':
            loginPhone.classList.add("error");
            showLoginError(result.message || "Вход в аккаунт запрещён.");
            break;
        case 'terms_not_accepted':
            loginRulesCheck.classList.add("error");
            showLoginError("Необходимо согласие с правилами");
            break;
        case 'server_error':
            showLoginError("Внутренняя ошибка сервера. Попробуйте позже.");
            break;
        default:
            showLoginError(result.message || "Произошла ошибка при входе");
    }
}

// Обработчик для кнопки "Зарегистрироваться"
document.querySelector('.register-redirect-btn').addEventListener('click', () => {
    // Переключение на экран регистрации
    window.taxiApp.showScreen('register-screen');
});