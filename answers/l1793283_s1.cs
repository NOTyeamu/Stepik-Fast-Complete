using System;

class Program
{
    static void Main()
    {
        string stroka = Console.ReadLine();
        int summa = 0;

        foreach (char bukva in stroka)
        {
            summa = summa + (bukva - '0');
        }

        if (summa % 2 == 0)
        {
            Console.WriteLine("Сумма чётная");
        }
        else
        {
            Console.WriteLine("Сумма нечётная");
        }
    }
}