let registartionType = null;

const clientChoice = document.querySelector('.register-choice-client');
const taxiChoice = document.querySelector('.register-choice-taxi');
const registerRulesCheck = document.getElementById('registerRulesCheck');
const registerChoiceButton = document.getElementById('register-choice-btn');

const registerChoiceContainer = document.querySelector('.register-choice-container'); 
const registerClientContainer = document.querySelector('.register-client-container');
const registerTaxiContainer = document.querySelector('.register-taxi-container');

const registerClientPhone = document.getElementById('registerPhone');
const registerClientName = document.getElementById('registerName');
const registerClientSurname = document.getElementById('registerSurname');
const registerClientPassword = document.getElementById('registerPassword');
const registerButton = document.getElementById('register-btn');
const registerPasswordToggle = document.querySelector('.password-toggle');
const registrationMessageClient = document.getElementById('registrationMessageClient');
const registerInputs = document.querySelector('.register-inputs');


// Добавляем сообщение для отображения статуса
if (!registrationMessageClient) {
    const messageDiv = document.createElement('div');
    messageDiv.id = 'registrationMessageClient';
    messageDiv.className = 'registration-message-client';
    registerClientContainer.insertBefore(messageDiv, registerButton);
}

clientChoice.addEventListener("click", () => {
  clientChoice.classList.add("active");
  clientChoice.classList.remove("error");
  taxiChoice.classList.remove("error");
  taxiChoice.classList.remove("active");
  registartionType = "client";
  registerChoiceButton.disabled = false;
  
});

taxiChoice.addEventListener("click", () => {
  taxiChoice.classList.add("active");
  taxiChoice.classList.remove("error");
  clientChoice.classList.remove("active");
  clientChoice.classList.remove("error");
  registartionType = "taxi";
  console.log("CLIENT:", registartionType)
  registerChoiceButton.disabled = false;
});

registerChoiceButton.addEventListener("click", () => {
  if (!registartionType) {
    taxiChoice.classList.add("error");
    clientChoice.classList.add("error");
    return;
  }
 
  if (registartionType === "client") {
    registerChoiceContainer.style.display = "none";
    registerClientContainer.style.display = "block";
    registerTaxiContainer.style.display = "none";
  } 
  
  else if (registartionType === "taxi") {
    registerChoiceContainer.style.display = "none";
    registerClientContainer.style.display = "none";
    registerTaxiContainer.style.display = "block";
  }
});

registerInputs.addEventListener("click", (e) => {
  // Если клик по фото-блоку, ничего не делаем
  if (e.target.closest('.photo-upload-item')) {
      return;
  }

  registerClientPhone.classList.remove("error");
  registerClientName.classList.remove("error");
  registerClientSurname.classList.remove("error");
  registerClientPassword.classList.remove("error");
  registerRulesCheck.classList.remove("error");

  registerClientPhone.style.borderColor = "";
  registerClientName.style.borderColor = "";
  registerClientSurname.style.borderColor = "";
  registerClientPassword.style.borderColor = "";
  registerRulesCheck.style.borderColor = "";
  hideMessageClient();
});


registerClientPhone.addEventListener("input", () => {
  let value = registerClientPhone.value.replace(/\D/g, '').slice(0, 9);
  let formatted = '';

  if (value.length > 0) formatted += value.slice(0, 2);
  if (value.length > 2) formatted += ' ' + value.slice(2, 5);
  if (value.length > 5) formatted += ' ' + value.slice(5, 7);
  if (value.length > 7) formatted += '-' + value.slice(7, 9);

  registerClientPhone.value = formatted.trim();
});

registerPasswordToggle.addEventListener("click", () => {
  if (registerClientPassword.type === "password") {
    registerClientPassword.type = "text";
    registerPasswordToggle.innerHTML = '<i class="fas fa-eye-slash"></i>';
  } else {
    registerClientPassword.type = "password";
    registerPasswordToggle.innerHTML = '<i class="fas fa-eye"></i>';
  }
});



registerButton.addEventListener("click", async () => {
  // Сброс предыдущих ошибок
  resetErrorsClient();
  hideMessageClient();

  let valid = true;

  // Валидация данных
  if (!registerClientPhone.value.match(/^\d{2} \d{3} \d{2}-\d{2}$/)) {
    registerClientPhone.classList.add("error");
    showErrorClient("Неверный формат телефона!");
    valid = false;
  }

  if (registerClientName.value.trim() === '') {
    registerClientName.classList.add("error");
    showErrorClient("Имя обязательно для заполнения!");
    valid = false;
  }

  if (registerClientSurname.value.trim() === '') {
    registerClientSurname.classList.add("error");
    showErrorClient("Фамилия обязательна для заполнения!");
    valid = false;
  }

  if (registerClientPassword.value.length < 6) {
    registerClientPassword.classList.add("error");
    showErrorClient("Пароль должен содержать минимум 6 символов!");
    valid = false;
  }

  if (!registerRulesCheck.checked) {
    registerRulesCheck.classList.add("error");
    showErrorClient("Необходимо согласие с правилами!");
    valid = false;
  }

  // Валидные коды номеров Азербайджана
  const validAzerbaijanCodes = [
    "77", "70", "50", "51", 
    "55", "40", "60", "12", 
    "20", "88", "99"];

  // Проверка кода телефона
  if (!validAzerbaijanCodes.includes(registerClientPhone.value.replace(/\D/g, "").substring(0, 2))) {
    registerClientPhone.classList.add("error");
    showErrorClient("Недопустимый код телефона!");
    valid = false;
  }
  

  if (!valid) return;

  // Показываем загрузку
  setLoadingClient(true);

  try {
    // Отправляем данные на сервер
    const response = await fetch('/api/registration-client', {
      method: 'POST',
      credentials: 'include', 
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: registerClientName.value.trim(),
        surname: registerClientSurname.value.trim(),
        phone: registerClientPhone.value,
        password: registerClientPassword.value,
        last_lat: window.taxiApp?.userLatLng?.lat || 0,
        last_lng: window.taxiApp?.userLatLng?.lng || 0,
        agree_to_terms: registerRulesCheck.checked
      })
    });

    const result = await response.json();

    if (result.success) {
      // Успешная регистрация
      showSuccessClient(result.message);
      
      // Перенаправляем на главную страницу через 2 секунды
      setTimeout(() => {
        registerClientName.value = '',
        registerClientSurname.value = '',
        registerClientPhone.value = '',
        registerClientPassword.value = '',
        registerRulesCheck.checked = false,
        window.profileManager.loadProfileData();
        window.taxiApp.showScreen('profile-screen')
        hideMessageClient();
        setLoadingClient(false);
      }, 1000);
      
    } else {
      // Обработка ошибок сервера
      handleServerError_registartionClient(result);
    }

  } catch (error) {
    console.error('Ошибка при регистрации:', error);
    showErrorClient('Ошибка соединения с сервером. Попробуйте позже.');
  } finally {
    setLoadingClient(false);
  }
});

// Функции для работы с сообщениями и состоянием
function showErrorClient(message) {
  const messageElement = document.getElementById('registrationMessageClient');
  if (messageElement) {
    messageElement.textContent = message;
    messageElement.classList.add('error');
    messageElement.classList.remove('success');
    messageElement.style.display = 'block';
  }
}

function showSuccessClient(message) {
  const messageElement = document.getElementById('registrationMessageClient');
  if (messageElement) {
    messageElement.textContent = message;
    messageElement.classList.add('success');
    messageElement.classList.remove('error');
    messageElement.style.display = 'block';
  }
}

function hideMessageClient() {
  const messageElement = document.getElementById('registrationMessageClient');
  if (messageElement) {
    messageElement.style.display = 'none';
    messageElement.textContent = '';
  }
}

function resetErrorsClient() {
  registerClientPhone.classList.remove("error");
  registerClientName.classList.remove("error");
  registerClientSurname.classList.remove("error");
  registerClientPassword.classList.remove("error");
  registerRulesCheck.classList.remove("error");
}

function setLoadingClient(loading) {
  if (loading) {
    registerButton.disabled = true;
    registerButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Регистрация...';
  } else {
    registerButton.disabled = false;
    registerButton.innerHTML = 'Зарегистрироваться';
  }
}

function handleServerError_registartionClient(result) {
  switch (result.error) {
    case 'phone_format':
      registerClientPhone.classList.add("error");
      showErrorClient("Неверный формат телефона");
      break;
    case 'name_required':
      registerClientName.classList.add("error");
      showErrorClient("Имя обязательно для заполнения");
      break;
    case 'surname_required':
      registerClientSurname.classList.add("error");
      showErrorClient("Фамилия обязательна для заполнения");
      break;
    case 'password_length':
      registerClientPassword.classList.add("error");
      showErrorClient("Пароль должен содержать минимум 6 символов");
      break;
    case 'terms_not_accepted':
      registerRulesCheck.classList.add("error");
      showErrorClient("Необходимо согласие с правилами");
      break;
    case 'phone_exists':
      registerClientPhone.classList.add("error");
      showErrorClient("Пользователь с таким телефоном уже существует");
      break;
    case 'server_error':
      showErrorClient("Внутренняя ошибка сервера. Попробуйте позже.");
      break;
    default:
      showErrorClient(result.message || "Произошла ошибка при регистрации");
  }
}

// Обработчик для кнопки "Зарегистрироваться"
document.querySelector('.client-to-login-redirect-btn').addEventListener('click', () => {
    // Переключение на экран регистрации
    window.taxiApp.showScreen('login-screen');
});